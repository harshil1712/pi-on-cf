import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PiEventsMessage } from '../shared/pi-contract'
import type { PiSession as TestPiSession } from '../server-test-entry'
import type { PiRegistry } from './pi-registry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<PiRegistry>
const session = (id: string) => env.PiSession.getByName(id) as unknown as DurableObjectStub<TestPiSession>

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

    await registry().deleteSession(first.id)
    expect(await registry().getSession(first.id)).toBeNull()
    expect((await registry().listSessions()).map(({ id }) => id)).not.toContain(first.id)
  })
})

describe('pi session', () => {
  it('starts with an empty workspace', async () => {
    const { id } = await registry().createSession()
    expect(await session(id).listFiles()).toEqual([])
  })

  it('answers a prompt through the pi-durable harness', async () => {
    const { id } = await registry().createSession()
    const result = await session(id).promptForTest('hello')

    expect(result.status).toBe('done')
    expect(result.text).toBe('echo: hello')
    expect(result.kinds).toEqual(expect.arrayContaining(['pi.user', 'pi.assistant']))
  })

  it('runs Computer tools from a model tool call', async () => {
    const { id } = await registry().createSession()
    const result = await session(id).promptForTest('write /workspace/hello.txt hi from pi')

    expect(result.status).toBe('done')
    expect(result.text).toMatch(/^tool said:/)
    expect(result.kinds).toContain('pi.tool-result')
    expect(await session(id).readWorkspaceFile('/workspace/hello.txt')).toMatchObject({ content: 'hi from pi' })
    expect((await session(id).listFiles()).map(({ path }) => path)).toEqual(['/workspace/hello.txt'])
  })

  it('lets the JavaScript backend write into a fresh workspace', async () => {
    const { id } = await registry().createSession()
    const module = "import { writeFile } from 'node:fs/promises'\nexport default async function () { await writeFile('/workspace/js.txt', 'from js'); return 'ok' }"
    const result = await session(id).promptForTest(`exec javascript ${module}`)

    expect(result.text).toMatch(/^tool said:/)
    expect(await session(id).readWorkspaceFile('/workspace/js.txt')).toMatchObject({ content: 'from js' })
  })

  it('streams a snapshot of pi events to connected clients', async () => {
    const { id } = await registry().createSession()
    await session(id).promptForTest('before connect')

    const response = await session(id).fetch(`http://localhost/api/agents/pi-session/${id}`, {
      headers: { Upgrade: 'websocket' },
    })
    const socket = response.webSocket
    expect(socket).toBeTruthy()
    socket!.accept()
    const message = await new Promise<PiEventsMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No pi:events frame')), 5_000)
      socket!.addEventListener('message', (event) => {
        const data = JSON.parse(String(event.data)) as { type?: string }
        if (data.type !== 'pi:events') return
        clearTimeout(timer)
        resolve(data as PiEventsMessage)
      })
    })
    socket!.close()

    const snapshot = message.events[0]
    expect(snapshot?.type).toBe('snapshot')
    expect(snapshot?.type === 'snapshot' && snapshot.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['pi.user', 'pi.assistant']))
  })
})
