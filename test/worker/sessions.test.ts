import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { routeAgentRequest } from 'agents'
import { describe, expect, it } from 'vitest'
import { type PiEventsMessage, sessionBasePath } from '~/contract'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'
import { AGENT_ROUTES } from '~/server/agent-routes'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

/** The Agent behind a catalog entry, reached directly for test-only RPC. */
async function session(id: string): Promise<DurableObjectStub<TestPiSession>> {
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession>
}

/** Route a request the way the Worker does. */
function route(path: string, init?: RequestInit): Promise<Response | null> {
  return routeAgentRequest(new Request(`http://localhost/${path}`, init), env, AGENT_ROUTES)
}

const upgrade = { headers: { Upgrade: 'websocket' } }

/** Every frame the socket receives until the first `pi:events` frame. */
async function framesUntilPiEvents(socket: WebSocket): Promise<{ events: PiEventsMessage; frames: unknown[] }> {
  const frames: unknown[] = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No pi:events frame')), 5_000)
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)) as { type?: string }
      frames.push(data)
      if (data.type !== 'pi:events') return
      clearTimeout(timer)
      resolve({ events: data as PiEventsMessage, frames })
    })
  })
}

describe('session registry', () => {
  it('creates, lists, renames and deletes sessions', async () => {
    const first = await registry().createSession({ name: 'First session' })
    const second = await registry().createSession()

    expect(first.id).not.toBe(second.id)
    expect(first.name).toBe('First session')
    expect(second.name).toBeUndefined()
    expect((await registry().listSessions()).map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]))

    const renamed = await registry().renameSession(second.id, '  Second  ')
    expect(renamed.name).toBe('Second')
    expect((await registry().getSession(second.id))?.name).toBe('Second')
    expect((await registry().renameSession(second.id, '  ')).name).toBeUndefined()

    await registry().deleteSession(first.id)
    expect(await registry().getSession(first.id)).toBeNull()
    expect((await registry().listSessions()).map(({ id }) => id)).not.toContain(first.id)
  })

  it('lists the session that last accepted a prompt first', async () => {
    const older = await registry().createSession({ name: 'Older' })
    const newer = await registry().createSession({ name: 'Newer' })
    expect((await registry().listSessions())[0]?.id).toBe(newer.id)

    // submit() reports to the registry after it returns.
    await (await session(older.id)).submit('hello')
    await expect.poll(async () => (await registry().listSessions())[0]?.id).toBe(older.id)
    const touched = await registry().getSession(older.id)
    expect(Date.parse(touched!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(older.updatedAt))
  })
})

describe('session routing', () => {
  it('serves a session through the registry, without revealing its Agent name', async () => {
    const { id } = await registry().createSession()
    await (await session(id)).promptForTest('before connect')
    const agentName = await registry().sessionAgentNameForTest(id)

    const response = await route(sessionBasePath(id), upgrade)
    expect(response?.status).toBe(101)
    const socket = response!.webSocket!
    socket.accept()
    const { events, frames } = await framesUntilPiEvents(socket)
    socket.close()

    const snapshot = events.events[0]
    expect(snapshot?.type).toBe('snapshot')
    expect(snapshot?.type === 'snapshot' && snapshot.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['pi.user', 'pi.assistant']))
    expect(frames.some((frame) => (frame as { type?: string }).type === 'cf_agent_identity')).toBe(false)
    expect(agentName).toBeTruthy()
    expect(JSON.stringify(frames)).not.toContain(agentName)
  })

  it('runs the browser\'s callables over the routed socket', async () => {
    const { id } = await registry().createSession()
    await (await session(id)).promptForTest('write /workspace/routed.txt via the registry')

    const response = await route(sessionBasePath(id), upgrade)
    const socket = response!.webSocket!
    socket.accept()
    // The frame AgentClient sends for `agent.stub.listFiles()`.
    const result = new Promise<{ success: boolean; result?: unknown; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No RPC response')), 5_000)
      socket.addEventListener('message', (event) => {
        const data = JSON.parse(String(event.data)) as { type?: string; id?: string }
        if (data.type !== 'rpc' || data.id !== 'list-1') return
        clearTimeout(timer)
        resolve(data as { success: boolean; result?: unknown })
      })
    })
    socket.send(JSON.stringify({ type: 'rpc', id: 'list-1', method: 'listFiles', args: [] }))
    const reply = await result
    socket.close()

    expect(reply.success, reply.error).toBe(true)
    expect((reply.result as { path: string }[]).map(({ path }) => path)).toEqual(['/workspace/routed.txt'])
  })

  it('answers 404 for a session the catalog does not hold', async () => {
    const response = await route(sessionBasePath(crypto.randomUUID()), upgrade)
    expect(response?.status).toBe(404)
  })

  it('refuses direct routes to a session Agent', async () => {
    const { id } = await registry().createSession()
    for (const name of [id, crypto.randomUUID()]) {
      expect((await route(`api/agents/pi-session/${name}`, upgrade))?.status).toBe(404)
      expect((await route(`api/agents/pi-session/${name}`))?.status).toBe(404)
    }
  })

  it('still routes to the registry itself', async () => {
    const response = await route('api/agents/pi-registry/singleton', upgrade)
    expect(response?.status).toBe(101)
    response!.webSocket!.accept()
    response!.webSocket!.close()
  })
})

describe('pi session', () => {
  it('deletes its transcript and workspace without failing the registry call', async () => {
    const { id } = await registry().createSession()
    const agentName = await registry().sessionAgentNameForTest(id)
    // A fresh stub per call: a stub that saw the isolate abort stays broken.
    const agent = () => env.PiSession.getByName(agentName!) as unknown as DurableObjectStub<TestPiSession>
    const doomed = agent()
    await doomed.promptForTest('write /workspace/doomed.txt bye')
    expect((await doomed.listFiles()).map(({ path }) => path)).toEqual(['/workspace/doomed.txt'])

    await registry().deleteSession(id)
    expect(await registry().getSession(id)).toBeNull()
    expect(await registry().sessionAgentNameForTest(id)).toBeNull()

    // RoutedAgents condemns the Agent; the wipe runs in its own alarm.
    expect(await runDurableObjectAlarm(agent())).toBe(true)
    // A request that lands while the destroyed instance shuts down fails once;
    // the next one reaches a fresh, empty instance.
    const files = await agent().listFiles().catch(() => agent().listFiles())
    expect(files).toEqual([])
    const fresh = await agent().promptForTest('hello again')
    expect(fresh.kinds.filter((kind) => kind === 'pi.user')).toHaveLength(1)
  })

  it('starts with an empty workspace', async () => {
    const { id } = await registry().createSession()
    expect(await (await session(id)).listFiles()).toEqual([])
  })

  it('answers a prompt through the pi-durable harness', async () => {
    const { id } = await registry().createSession()
    const result = await (await session(id)).promptForTest('hello')

    expect(result.status).toBe('done')
    expect(result.text).toBe('echo: hello')
    expect(result.kinds).toEqual(expect.arrayContaining(['pi.user', 'pi.assistant']))
  })

  it('tells the model where to commit, to ask first, and to keep exit codes', async () => {
    const { id } = await registry().createSession()
    const { text } = await (await session(id)).promptForTest('section preamble')
    expect(text).toContain('Commit with git in the shell backend')
    expect(text).toContain('do not set user.name or user.email, or pass -c')
    expect(text).toContain('Do not commit, or open or update a pull request, unless the user asked you to')
    expect(text).toContain('do not pipe tests, builds, lint or type checks into head, tail or grep')
    expect(text).toContain('set -o pipefail')
  })

  it('runs Computer tools from a model tool call', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    const result = await pi.promptForTest('write /workspace/hello.txt hi from pi')

    expect(result.status).toBe('done')
    expect(result.text).toMatch(/^tool said:/)
    expect(result.kinds).toContain('pi.tool-result')
    expect(await pi.readWorkspaceFile('/workspace/hello.txt')).toMatchObject({ content: 'hi from pi' })
    expect((await pi.listFiles()).map(({ path }) => path)).toEqual(['/workspace/hello.txt'])
  })

  it('leaves dependencies and git internals out of the file list at any depth', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    for (const path of [
      '/workspace/node_modules/top/index.js',
      '/workspace/.git/HEAD',
      '/workspace/app/node_modules/nested/index.js',
      '/workspace/app/.git/HEAD',
      '/workspace/app/src.js',
    ]) {
      expect((await pi.promptForTest(`write ${path} x`)).text).toMatch(/^tool said:/)
    }

    expect((await pi.listFiles()).map(({ path }) => path)).toEqual(['/workspace/app/src.js'])
  })

  it('lets the JavaScript backend write into a fresh workspace', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    const module = "import { writeFile } from 'node:fs/promises'\nexport default async function () { await writeFile('/workspace/js.txt', 'from js'); return 'ok' }"
    const result = await pi.promptForTest(`exec javascript ${module}`)

    expect(result.text).toMatch(/^tool said:/)
    expect(await pi.readWorkspaceFile('/workspace/js.txt')).toMatchObject({ content: 'from js' })
  })
})
