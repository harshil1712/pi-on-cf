import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { describe, expect, it } from 'vitest'
import { AGENT_ROUTES } from '~/server/agent-routes'
import { sessionBasePath } from '~/shared/pi-contract'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

async function newSession(): Promise<{ id: string; pi: DurableObjectStub<TestPiSession> }> {
  const { id } = await registry().createSession()
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return { id, pi: env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession> }
}

/** One callable over a session's WebSocket, the way AgentClient sends it from the browser. */
function call(id: string, method: string, args: unknown[]) {
  return callAt(`http://localhost/${sessionBasePath(id)}`, method, args)
}

/** One callable over an Agent's WebSocket. Rejections arrive as replies, as the browser sees them. */
async function callAt(url: string, method: string, args: unknown[]): Promise<{ success: boolean; result?: unknown; error?: string }> {
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

describe('model picker', () => {
  it('starts a session on the default model and lists the choices', async () => {
    const { id, pi } = await newSession()
    expect((await pi.state).model).toBe('faux-a')
    expect((await call(id, 'listModels', [])).result).toEqual([{ id: 'faux-a', label: 'Faux A' }, { id: 'faux-b', label: 'Faux B' }])
    expect((await pi.promptForTest('model')).text).toBe('model: faux-a')
  })

  it('answers the next prompt with the model chosen', async () => {
    const { id, pi } = await newSession()
    const reply = await call(id, 'setModel', ['faux-b'])
    expect(reply.success, reply.error).toBe(true)
    expect((await pi.state).model).toBe('faux-b')
    expect((await pi.promptForTest('model')).text).toBe('model: faux-b')
  })

  it('keeps the model when the task changes', async () => {
    const { pi } = await newSession()
    await pi.setModel('faux-b')
    await pi.setTaskForTest({ 'README.md': 'demo' })
    expect((await pi.state).model).toBe('faux-b')
  })

  it('refuses a model it does not offer', async () => {
    const { id, pi } = await newSession()
    const reply = await call(id, 'setModel', ['nope'])
    expect(reply.success).toBe(false)
    expect(reply.error).toBe('Unknown model: nope')
    expect((await pi.state).model).toBe('faux-a')
  })

  it('starts a session from the home page on the model chosen there', async () => {
    const { id } = await registry().createSession({ prompt: 'hello', model: 'faux-b' })
    const name = await registry().sessionAgentNameForTest(id)
    const pi = env.PiSession.getByName(name!) as unknown as DurableObjectStub<TestPiSession>
    expect((await pi.state).model).toBe('faux-b')
    expect((await pi.promptForTest('model')).text).toBe('model: faux-b')
  })

  it('creates no session for a model it does not offer', async () => {
    const before = (await registry().listSessions()).length
    const reply = await callAt('http://localhost/api/agents/pi-registry/singleton', 'createSession', [{ prompt: 'hello', model: 'nope' }])
    expect(reply.success).toBe(false)
    expect(reply.error).toBe('Unknown model: nope')
    expect(await registry().listSessions()).toHaveLength(before)
  })

  it('lists the models for the home page', async () => {
    expect((await callAt('http://localhost/api/agents/pi-registry/singleton', 'listModels', [])).result).toEqual([{ id: 'faux-a', label: 'Faux A' }, { id: 'faux-b', label: 'Faux B' }])
  })
})
