import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { describe, expect, it } from 'vitest'
import { AGENT_ROUTES } from '~/server/agent-routes'
import { parseRepo } from '~/server/github'
import { sessionBasePath } from '~/contract'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

async function session(id: string): Promise<DurableObjectStub<TestPiSession>> {
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession>
}

const REGISTRY_URL = 'http://localhost/api/agents/pi-registry/singleton'
const sessionUrl = (id: string) => `http://localhost/${sessionBasePath(id)}`

/** One callable over an Agent's WebSocket, the way AgentClient sends it from the browser. */
async function call(url: string, method: string, args: unknown[]): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const response = await routeAgentRequest(new Request(url, { headers: { Upgrade: 'websocket' } }), env, AGENT_ROUTES)
  const socket = response!.webSocket!
  socket.accept()
  const reply = new Promise<{ success: boolean; result?: unknown; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No RPC response')), 10_000)
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)) as { type?: string; id?: string }
      if (data.type !== 'rpc' || data.id !== 'call-1') return
      clearTimeout(timer)
      resolve(data as { success: boolean })
    })
  })
  socket.send(JSON.stringify({ type: 'rpc', id: 'call-1', method, args }))
  try {
    return await reply
  } finally {
    socket.close()
  }
}

async function taskSession(files: Record<string, string>) {
  const { id } = await registry().createSession()
  const pi = await session(id)
  const task = await pi.setTaskForTest(files)
  return { id, pi, task }
}

describe('repository parsing', () => {
  it('accepts owner/name and GitHub URLs', () => {
    expect(parseRepo('octo/demo')).toEqual({ owner: 'octo', name: 'demo' })
    expect(parseRepo(' https://github.com/octo/demo.git ')).toEqual({ owner: 'octo', name: 'demo' })
    expect(parseRepo('https://github.com/octo/demo/')).toEqual({ owner: 'octo', name: 'demo' })
  })

  it('refuses anything else', () => {
    for (const input of ['octo', 'octo/demo/tree', 'https://gitlab.com/octo/demo', 'octo/de mo', '']) {
      expect(() => parseRepo(input), input).toThrow(/not a GitHub repository/)
    }
  })
})

describe('repository sessions', () => {
  it('leaves cloning to the model: a mention alone clones nothing', async () => {
    const { id } = await registry().createSession()
    const reply = await call(sessionUrl(id), 'submit', ['What does @octo/demo do?'])
    expect(reply.success, reply.error).toBe(true)
    const pi = await session(id)
    const { text } = await pi.promptForTest('section repository')
    expect(text).toContain('@owner/name')
    expect(text).toContain('clone_repository')
    expect(await pi.listChanges()).toEqual([])
  })

  it('reports a failed clone to the model and stays without a repository', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    const result = await pi.promptForTest('tool clone_repository {"repo":"octo/demo"}')
    expect(result.text).toBe('tool failed: Set the GITHUB_TOKEN secret to work on GitHub repositories.')
    expect((await pi.promptForTest('section repository')).text).toContain('call clone_repository')
    expect(await registry().getSession(id)).not.toHaveProperty('repo')
  })

  it('clones one repository per session', async () => {
    const { pi } = await taskSession({ 'README.md': 'one\n' })
    // The same repository again, as a replayed call would, reports the clone.
    expect((await pi.promptForTest('tool clone_repository {"repo":"@Octo/Demo"}')).text).toBe('tool said: Cloned octo/demo#main at /workspace/demo, on the branch pi/test.')
    expect((await pi.promptForTest('tool clone_repository {"repo":"octo/other"}')).text).toBe('tool failed: This session already cloned octo/demo, and works on one repository.')
  })

  it('needs a GitHub token to suggest repositories', async () => {
    const reply = await call(REGISTRY_URL, 'listRepositories', [])
    expect(reply.success).toBe(false)
    expect(reply.error).toMatch(/GITHUB_TOKEN/)
  })

  it('tells the model about its repository and AGENTS.md', async () => {
    const { pi } = await taskSession({ 'README.md': '# demo\n', 'AGENTS.md': 'Run npm test before committing.\n' })
    const { text } = await pi.promptForTest('section repository')
    expect(text).toContain('octo/demo')
    expect(text).toContain('/workspace/demo')
    expect(text).toContain('pi/test')
    expect(text).toContain('create_pull_request')
    expect(text).toContain('Run npm test before committing.')
  })

  it('lists and diffs changes against the base commit, committed or not', async () => {
    const { pi } = await taskSession({ 'README.md': 'one\n', 'old.txt': 'bye\n' })
    expect(await pi.listChanges()).toEqual([])

    // The agent's own tools: an edit it commits with the shell's git, a new
    // file and a deletion it leaves uncommitted.
    await pi.promptForTest('write /workspace/demo/README.md one\ntwo')
    const commit = await pi.promptForTest('exec shell cd /workspace/demo && git add README.md && git commit -m "Add two"')
    expect(commit.text).toMatch(/^tool said:/)
    // Without any git config: the identity the preamble promises.
    expect((await pi.promptForTest('exec shell cd /workspace/demo && git log -1 --format="%an <%ae>"')).text).toContain('Pi <pi@cloudflare.invalid>')
    await pi.promptForTest('write /workspace/demo/new.txt hello')
    await pi.promptForTest('exec shell rm /workspace/demo/old.txt')

    const changes = await pi.listChanges()
    expect(changes.map(({ path, status }) => `${status} ${path}`).sort((a, b) => a.localeCompare(b))).toEqual(['A new.txt', 'D old.txt', 'M README.md'])
    expect(changes.find(({ path }) => path === 'README.md')).toMatchObject({ insertions: 1 })
    const diff = await pi.readChange('README.md')
    expect(diff).toContain('+two')
    expect(diff).not.toContain('new.txt')
  })

  it('refuses to open a pull request from a session without a repository', async () => {
    const { id } = await registry().createSession()
    const result = await (await session(id)).promptForTest('tool create_pull_request {"title":"t","body":"b"}')
    expect(result.text).toBe('tool failed: This session has no repository.')
  })

  it('refuses to open a pull request without a GitHub token', async () => {
    const { pi } = await taskSession({ 'README.md': 'one\n' })
    const result = await pi.promptForTest('tool create_pull_request {"title":"t","body":"b"}')
    expect(result.text).toBe('tool failed: GITHUB_TOKEN is not set.')
  })

  it('refuses to open a pull request with uncommitted changes', async () => {
    const { pi } = await taskSession({ 'README.md': 'one\n' })
    await pi.useGitHubTokenForTest('test-token')
    await pi.promptForTest('write /workspace/demo/README.md changed')
    const result = await pi.promptForTest('tool create_pull_request {"title":"t","body":"b"}')
    expect(result.text).toMatch(/^tool failed: Commit or discard these changes first:\n.*README\.md/)
  })

  it('reports a failed push to the model', async () => {
    // The test repository has no origin remote to push to.
    const { pi } = await taskSession({ 'README.md': 'one\n' })
    await pi.useGitHubTokenForTest('test-token')
    const result = await pi.promptForTest('tool create_pull_request {"title":"t","body":"b"}')
    expect(result.text).toMatch(/^tool failed: Push failed: /)
  })

  it('syncs the task to clients, who cannot change it', async () => {
    const { id, pi, task } = await taskSession({ 'README.md': 'one\n' })
    const response = await routeAgentRequest(new Request(`http://localhost/${sessionBasePath(id)}`, { headers: { Upgrade: 'websocket' } }), env, AGENT_ROUTES)
    const socket = response!.webSocket!
    socket.accept()
    const frames: { type?: string; state?: unknown }[] = []
    socket.addEventListener('message', (event) => { frames.push(JSON.parse(String(event.data))) })
    await expect.poll(() => frames.find((frame) => frame.type === 'cf_agent_state')).toBeTruthy()
    expect(frames.find((frame) => frame.type === 'cf_agent_state')?.state).toEqual({ task, model: 'faux-a' })

    socket.send(JSON.stringify({ type: 'cf_agent_state', state: { task: { ...task, branch: 'main' }, model: 'faux-b' } }))
    await expect.poll(() => frames.some((frame) => frame.type === 'cf_agent_state_error')).toBe(true)
    socket.close()
    expect((await pi.promptForTest('section repository')).text).toContain('branch pi/test')
  })
})
