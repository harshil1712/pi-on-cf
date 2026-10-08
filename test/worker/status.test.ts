import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { describe, expect, it } from 'vitest'
import { AGENT_ROUTES } from '~/server/agent-routes'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

async function session(id: string): Promise<DurableObjectStub<TestPiSession>> {
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession>
}

const summary = async (id: string) => {
  const found = await registry().getSession(id)
  if (!found) throw new Error(`Session not found: ${id}`)
  return found
}

/** The registry revisions an open page sees, from its WebSocket. */
async function watchRevisions(): Promise<{ revisions: number[]; close: () => void }> {
  const response = await routeAgentRequest(new Request('http://localhost/api/agents/pi-registry/singleton', { headers: { Upgrade: 'websocket' } }), env, AGENT_ROUTES)
  const socket = response!.webSocket!
  socket.accept()
  const revisions: number[] = []
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(String(event.data)) as { type?: string; state?: { revision: number } }
    if (data.type === 'cf_agent_state' && data.state) revisions.push(data.state.revision)
  })
  await expect.poll(() => revisions.length).toBeGreaterThan(0)
  return { revisions, close: () => socket.close() }
}

describe('session run status', () => {
  it('is running during a run and idle after, and each change moves the session up', async () => {
    const { id } = await registry().createSession({ name: 'Status', prompt: 'hello' })
    await expect.poll(async () => (await summary(id)).status, { timeout: 10_000 }).toBe('idle')
    await registry().setTask(id, { repo: 'octo/demo', branch: 'pi/test' })
    const page = await watchRevisions()

    const before = await summary(id)
    const start = page.revisions.at(-1)!
    await (await session(id)).submit('slow')
    await expect.poll(async () => (await summary(id)).status, { timeout: 10_000 }).toBe('running')
    const running = await summary(id)
    expect(Date.parse(running.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
    expect(page.revisions.at(-1)).toBeGreaterThan(start)

    await expect.poll(async () => (await summary(id)).status, { timeout: 20_000 }).toBe('idle')
    const after = await summary(id)
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(running.updatedAt))
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
    await expect.poll(() => page.revisions.at(-1)).toBeGreaterThan(start + 1)
    // The status reports keep what the prompt, the task and the name set.
    expect(after).toMatchObject({ name: 'Status', title: 'hello', repo: 'octo/demo', branch: 'pi/test' })
    // The most recently changed session lists first.
    expect((await registry().listSessions())[0]?.id).toBe(id)
    page.close()
  })

  it('marks a failed run failed until the next run starts', async () => {
    const { id } = await registry().createSession({ prompt: 'fail' })
    await expect.poll(async () => (await summary(id)).status, { timeout: 10_000 }).toBe('failed')
    expect((await summary(id)).title).toBe('fail')

    await (await session(id)).submit('hello again')
    await expect.poll(async () => (await summary(id)).status, { timeout: 10_000 }).toBe('idle')
  })

  it('reports nothing when the status has not changed', async () => {
    const { id } = await registry().createSession()
    const before = await summary(id)
    await registry().setStatus(id, 'idle')
    expect((await summary(id)).updatedAt).toBe(before.updatedAt)
  })

  it('corrects a stale running status when the session starts again', async () => {
    const { id } = await registry().createSession({ prompt: 'hello' })
    await expect.poll(async () => (await summary(id)).status, { timeout: 10_000 }).toBe('idle')
    // What the registry keeps when a report of the run's end was lost.
    await registry().setStatus(id, 'running')
    expect((await summary(id)).status).toBe('running')

    await (await session(id)).restartForTest('running')
    expect(await summary(id)).toMatchObject({ status: 'idle', title: 'hello' })
  })

  it('keeps a failure across a restart', async () => {
    const { id } = await registry().createSession({ prompt: 'fail' })
    await expect.poll(async () => (await summary(id)).status, { timeout: 10_000 }).toBe('failed')
    await (await session(id)).restartForTest()
    expect((await summary(id)).status).toBe('failed')
  })
})
