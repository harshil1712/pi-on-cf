import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { sign } from '@octokit/webhooks-methods'
import { describe, expect, it } from 'vitest'
import { AGENT_ROUTES } from '~/server/agent-routes'
import { followUpPrompt, type GitHubMention, handleGitHubWebhook, issuePrompt, mentionFromEvent } from '~/server/github-webhook'
import { type PiEventsMessage, sessionBasePath } from '~/contract'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

async function session(id: string): Promise<DurableObjectStub<TestPiSession>> {
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession>
}

/** The text of the session's prompts, from the snapshot a browser gets on connect. */
async function prompts(id: string): Promise<string> {
  const response = await routeAgentRequest(new Request(`http://localhost/${sessionBasePath(id)}`, { headers: { Upgrade: 'websocket' } }), env, AGENT_ROUTES)
  const socket = response!.webSocket!
  socket.accept()
  try {
    const entries = await new Promise<{ kind: string; model?: unknown }[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No pi:events frame')), 5_000)
      socket.addEventListener('message', (event) => {
        const data = JSON.parse(String(event.data)) as PiEventsMessage
        const snapshot = data.type === 'pi:events' ? data.events[0] : undefined
        if (snapshot?.type !== 'snapshot') return
        clearTimeout(timer)
        resolve(snapshot.entries as unknown as { kind: string; model?: unknown }[])
      })
    })
    return JSON.stringify(entries.filter((entry) => entry.kind === 'pi.user'))
  } finally {
    socket.close()
  }
}

const config = { GITHUB_WEBHOOK_SECRET: 'test-webhook-secret', GITHUB_APP_SLUG: 'pi-test', GITHUB_OWNERS: 'octo, Org' }

let nextNumber = 100
const user = (login: string, type = 'User') => ({ login, type })

/** An `issue_comment` payload: on a pull request when `pullRequest` is set. */
function issueComment(body: string, options: { sender?: string; senderType?: string; action?: string; number?: number; pullRequest?: boolean; issueAuthor?: string } = {}) {
  const number = options.number ?? ++nextNumber
  return {
    action: options.action ?? 'created',
    issue: {
      number,
      title: 'Crash on start',
      body: 'It crashes.',
      html_url: `https://github.com/octo/demo/issues/${number}`,
      user: user(options.issueAuthor ?? 'octo'),
      ...(options.pullRequest ? { pull_request: { url: 'x' } } : {}),
    },
    comment: { id: 7000 + number, body, html_url: `https://github.com/octo/demo/issues/${number}#issuecomment-1` },
    repository: { full_name: 'octo/demo' },
    sender: user(options.sender ?? 'octo', options.senderType),
  }
}

describe('mentionFromEvent', () => {
  it('reads a trusted mention on an issue', () => {
    const mention = mentionFromEvent('issue_comment', issueComment('@pi-test please fix', { number: 5, issueAuthor: 'stranger' }), config)
    expect(mention).toMatchObject({
      repo: 'octo/demo',
      number: 5,
      kind: 'issue',
      title: 'Crash on start',
      author: 'octo',
      body: '@pi-test please fix',
      comment: { id: 7005 },
      description: { body: 'It crashes.', author: 'stranger', trusted: false },
    })
  })

  it('tells a pull request\'s comments from an issue\'s', () => {
    expect(mentionFromEvent('issue_comment', issueComment('Thanks @pi-test.', { pullRequest: true }), config)?.kind).toBe('pull_request')
  })

  it('reads a review comment with its place in the diff', () => {
    const payload = {
      action: 'created',
      pull_request: { number: 6, title: 'Fix crash', body: null, html_url: 'https://github.com/octo/demo/pull/6', user: user('pi-test[bot]', 'Bot') },
      comment: { id: 9, body: '@PI-TEST rename this', html_url: 'u', path: 'src/a.ts', line: 3, diff_hunk: '@@ -1 +1 @@' },
      repository: { full_name: 'octo/demo' },
      sender: user('Octo'),
    }
    expect(mentionFromEvent('pull_request_review_comment', payload, config)).toMatchObject({
      number: 6,
      kind: 'pull_request',
      comment: { id: 9, review: { path: 'src/a.ts', line: 3, diffHunk: '@@ -1 +1 @@' } },
      description: { body: '', trusted: false },
    })
  })

  it('ignores everything else', () => {
    const ignored = {
      'no mention': issueComment('please fix'),
      'a longer name': issueComment('@pi-testing please fix'),
      'an email address': issueComment('mail me at me@pi-test.dev'),
      'an untrusted user': issueComment('@pi-test please fix', { sender: 'stranger' }),
      'a bot': issueComment('@pi-test please fix', { sender: 'octo', senderType: 'Bot' }),
      'an edit': issueComment('@pi-test please fix', { action: 'edited' }),
    }
    for (const [name, payload] of Object.entries(ignored)) expect(mentionFromEvent('issue_comment', payload, config), name).toBeNull()
    expect(mentionFromEvent('issues', issueComment('@pi-test'), config)).toBeNull()
  })
})

describe('prompts', () => {
  const mention = mentionFromEvent('issue_comment', issueComment('@pi-test please fix\nquickly', { number: 5, issueAuthor: 'stranger' }), config)!

  it('marks an untrusted author\'s issue as information, not instructions', () => {
    const prompt = issuePrompt(mention)
    expect(prompt).toContain('@octo mentioned you on issue #5 in octo/demo, "Crash on start"')
    expect(prompt).toContain('> @pi-test please fix\n> quickly')
    expect(prompt).toContain('@stranger, who is not a trusted user')
    expect(prompt).toContain('"Fixes #5"')
    expect(prompt).toContain('comment_on_github')
    expect(issuePrompt({ ...mention, description: { ...mention.description, author: 'octo', trusted: true } })).not.toContain('not a trusted user')
  })

  it('asks for an answer on GitHub after a follow-up', () => {
    const review = { ...mention, kind: 'pull_request' as const, comment: { ...mention.comment, review: { path: 'a.ts', line: 3, diffHunk: '@@ x @@' } } }
    const prompt = followUpPrompt(review)
    expect(prompt).toContain('on pull request #5')
    expect(prompt).toContain('The comment is on a.ts line 3:')
    expect(prompt).toContain('create_pull_request')
    expect(prompt).toContain('comment_on_github')
  })
})

/** A delivery signed with the test secret, or with `signature` when given. */
async function delivery(event: string, payload: unknown, signature?: string | null): Promise<Request> {
  const body = JSON.stringify(payload)
  const headers = new Headers({ 'X-GitHub-Event': event, 'X-GitHub-Delivery': crypto.randomUUID(), 'Content-Type': 'application/json' })
  const value = signature === undefined ? await sign('test-webhook-secret', body) : signature
  if (value) headers.set('X-Hub-Signature-256', value)
  return new Request('http://localhost/webhooks/github', { method: 'POST', headers, body })
}

describe('the webhook endpoint', () => {
  it('refuses a missing or wrong signature', async () => {
    const payload = issueComment('@pi-test hi')
    expect((await handleGitHubWebhook(await delivery('issue_comment', payload, null), env)).status).toBe(401)
    expect((await handleGitHubWebhook(await delivery('issue_comment', payload, await sign('wrong', JSON.stringify(payload))), env)).status).toBe(401)
    expect((await handleGitHubWebhook(new Request('http://localhost/webhooks/github'), env)).status).toBe(405)
  })

  it('answers a signed delivery that is not JSON with 400', async () => {
    const request = new Request('http://localhost/webhooks/github', { method: 'POST', headers: { 'X-GitHub-Event': 'issue_comment', 'X-Hub-Signature-256': await sign('test-webhook-secret', 'not json') }, body: 'not json' })
    expect((await handleGitHubWebhook(request, env)).status).toBe(400)
  })

  it('answers events without a mention with 204', async () => {
    expect((await handleGitHubWebhook(await delivery('issue_comment', issueComment('no mention')), env)).status).toBe(204)
    expect((await handleGitHubWebhook(await delivery('ping', { zen: 'hi' }), env)).status).toBe(204)
  })

  it('queues a mention, which starts a session for the issue', async () => {
    const payload = issueComment('@pi-test please fix')
    const response = await handleGitHubWebhook(await delivery('issue_comment', payload), env)
    expect(response.status).toBe(202)
    const title = `octo/demo#${payload.issue.number}: Crash on start`
    await expect.poll(async () => (await registry().listSessions()).some((entry) => entry.title === title), { timeout: 10_000 }).toBe(true)
  })
})

describe('routing mentions', () => {
  const mention = (number: number, kind: GitHubMention['kind'], body: string): GitHubMention =>
    mentionFromEvent('issue_comment', issueComment(body, { number, pullRequest: kind === 'pull_request' }), config)!

  it('starts one session per issue, and sends later mentions to it', async () => {
    const number = ++nextNumber
    await registry().handleGitHubMention(mention(number, 'issue', '@pi-test first'))
    const title = `octo/demo#${number}: Crash on start`
    const started = (await registry().listSessions()).filter((entry) => entry.title === title)
    expect(started).toHaveLength(1)
    await expect.poll(() => prompts(started[0]!.id), { timeout: 10_000 }).toContain('@pi-test first')

    await registry().handleGitHubMention(mention(number, 'issue', '@pi-test second'))
    expect((await registry().listSessions()).filter((entry) => entry.title === title)).toHaveLength(1)
    await expect.poll(() => prompts(started[0]!.id), { timeout: 10_000 }).toContain('@pi-test second')

    // The session knows its issue: commenting there needs only the App.
    const reply = await (await session(started[0]!.id)).promptForTest('tool comment_on_github {"body":"done","on":"issue"}')
    expect(reply.text).toMatch(/^tool failed: Set GITHUB_APP_ID/)
  })

  it('sends a mention on a pull request to the session that opened it', async () => {
    const number = ++nextNumber
    const { id } = await registry().createSession()
    await registry().setTask(id, { repo: 'Octo/Demo', branch: 'pi/x', pullRequest: { number, url: `https://github.com/octo/demo/pull/${number}` } })
    const before = (await registry().listSessions()).length
    await registry().handleGitHubMention(mention(number, 'pull_request', '@pi-test rename it'))
    await expect.poll(() => prompts(id), { timeout: 10_000 }).toContain('@pi-test rename it')
    expect((await registry().listSessions()).length).toBe(before)
  })

  it('starts nothing for a pull request without a session', async () => {
    const before = (await registry().listSessions()).length
    await registry().handleGitHubMention(mention(++nextNumber, 'pull_request', '@pi-test look'))
    expect((await registry().listSessions()).length).toBe(before)
  })
})

describe('comment_on_github', () => {
  it('needs an issue or pull request to comment on', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    expect((await pi.promptForTest('tool comment_on_github {"body":"hi"}')).text).toBe('tool failed: This session has no GitHub issue or pull request to comment on.')
    expect((await pi.promptForTest('tool comment_on_github {"body":"hi","on":"issue"}')).text).toBe('tool failed: This session has no issue to comment on.')
  })
})

describe('create_github_issue and read_github_issue', () => {
  it('need a repository when the session has none', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    expect((await pi.promptForTest('tool create_github_issue {"title":"Bug","body":"x"}')).text).toBe('tool failed: Name the repository, as owner/name: this session has none.')
    expect((await pi.promptForTest('tool read_github_issue {"number":1}')).text).toBe('tool failed: Name the repository, as owner/name: this session has none.')
    expect((await pi.promptForTest('tool create_github_issue {"title":"Bug","body":"x","repo":"not a repo"}')).text).toMatch(/^tool failed: "not a repo" is not a GitHub repository/)
  })

  it('use the GitHub App for the repository asked for', async () => {
    const { id } = await registry().createSession()
    const reply = await (await session(id)).promptForTest('tool create_github_issue {"title":"Bug","body":"x","repo":"@octo/demo"}')
    expect(reply.text).toMatch(/^tool failed: Set GITHUB_APP_ID/)
  })
})
