import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { describe, expect, it } from 'vitest'
import { AGENT_ROUTES } from '~/server/agent-routes'
import { type PiEventsMessage, sessionBasePath } from '~/contract'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

async function session(id: string): Promise<DurableObjectStub<TestPiSession>> {
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession>
}

/** The session's transcript entries, from the snapshot a browser gets on connect. */
async function transcript(id: string): Promise<{ kind: string; model?: unknown }[]> {
  const response = await routeAgentRequest(new Request(`http://localhost/${sessionBasePath(id)}`, { headers: { Upgrade: 'websocket' } }), env, AGENT_ROUTES)
  const socket = response!.webSocket!
  socket.accept()
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No pi:events frame')), 5_000)
      socket.addEventListener('message', (event) => {
        const data = JSON.parse(String(event.data)) as PiEventsMessage
        const snapshot = data.type === 'pi:events' ? data.events[0] : undefined
        if (snapshot?.type !== 'snapshot') return
        clearTimeout(timer)
        resolve(snapshot.entries as unknown as { kind: string; model?: unknown }[])
      })
    })
  } finally {
    socket.close()
  }
}

describe('sessions started from a prompt', () => {
  it('submits the prompt and titles the session from it', async () => {
    const created = await registry().createSession({ prompt: 'hello there' })
    expect(created.title).toBe('hello there')
    expect(created.name).toBeUndefined()
    expect((await registry().getSession(created.id))?.title).toBe('hello there')

    // The faux model echoes the prompt once the run finishes.
    await expect.poll(async () => JSON.stringify(await transcript(created.id)), { timeout: 10_000 }).toContain('echo: hello there')
    expect((await transcript(created.id)).filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
  })

  it('keeps the first prompt\'s title', async () => {
    const { id } = await registry().createSession({ prompt: 'first prompt' })
    await (await session(id)).submit('second prompt')
    await expect.poll(async () => JSON.stringify(await transcript(id)), { timeout: 10_000 }).toContain('echo: second prompt')
    // What the session reports for every later prompt.
    await registry().touchSession(id, 'third prompt')
    expect((await registry().getSession(id))?.title).toBe('first prompt')
  })

  it('titles a session created empty from its first prompt', async () => {
    const { id } = await registry().createSession()
    await (await session(id)).submit('  Look at\n the cache  ')
    await expect.poll(async () => (await registry().getSession(id))?.title).toBe('Look at')
  })

  it('keeps the title when the session is renamed', async () => {
    const { id } = await registry().createSession({ prompt: 'investigate the cache' })
    expect(await registry().renameSession(id, 'Cache')).toMatchObject({ name: 'Cache', title: 'investigate the cache' })
    expect(await registry().renameSession(id)).toMatchObject({ title: 'investigate the cache' })
    expect((await registry().getSession(id))?.name).toBeUndefined()
  })

  it('submits nothing for an empty prompt', async () => {
    const created = await registry().createSession({ prompt: '   ' })
    expect(created.title).toBeUndefined()
    expect((await transcript(created.id)).some((entry) => entry.kind === 'pi.user')).toBe(false)
    expect((await registry().getSession(created.id))?.title).toBeUndefined()
  })
})

describe('catalog revisions', () => {
  it('tells open pages when the catalog changes, and refuses their writes', async () => {
    const response = await routeAgentRequest(new Request('http://localhost/api/agents/pi-registry/singleton', { headers: { Upgrade: 'websocket' } }), env, AGENT_ROUTES)
    const socket = response!.webSocket!
    socket.accept()
    const revisions: number[] = []
    let refused = false
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)) as { type?: string; state?: { revision: number } }
      if (data.type === 'cf_agent_state' && data.state) revisions.push(data.state.revision)
      if (data.type === 'cf_agent_state_error') refused = true
    })
    await expect.poll(() => revisions.length).toBe(1)
    const start = revisions[0]!

    const { id } = await registry().createSession()
    await expect.poll(() => revisions.at(-1)).toBeGreaterThan(start)
    const created = revisions.at(-1)!
    await registry().renameSession(id, 'Renamed')
    await expect.poll(() => revisions.at(-1)).toBeGreaterThan(created)
    const renamed = revisions.at(-1)!
    await registry().deleteSession(id)
    await expect.poll(() => revisions.at(-1)).toBeGreaterThan(renamed)

    socket.send(JSON.stringify({ type: 'cf_agent_state', state: { revision: 0 } }))
    await expect.poll(() => refused).toBe(true)
    socket.close()
  })
})
