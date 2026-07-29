import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PiRegistry } from './pi-registry'
import type { SessionIndexEvent } from '../shared/pi-contract'

type RegistryStub = DurableObjectStub<PiRegistry>
type SessionStub = {
  getOverview(): ReturnType<import('./pi-session').PiSession['getOverview']>
  getBranch(): ReturnType<import('./pi-session').PiSession['getBranch']>
  importSession(snapshot: unknown): ReturnType<import('./pi-session').PiSession['getOverview']>
  readWorkspaceFile(path: string): ReturnType<import('./pi-session').PiSession['readWorkspaceFile']>
}

const registry = () => env.PiRegistry.getByName('singleton') as RegistryStub
const session = (id: string) => env.PiSession.getByName(id) as unknown as SessionStub

describe('durable sessions', () => {
  it('creates isolated named sessions and persists metadata', async () => {
    const first = await registry().createSession({ name: 'First session' })
    const second = await registry().createSession({ name: 'Second session' })

    expect(first.id).not.toBe(second.id)
    expect((await session(first.id).getOverview()).name).toBe('First session')
    expect((await session(second.id).getOverview()).name).toBe('Second session')
    expect((await registry().listSessions()).map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]))
  })

  it('indexes transcript text idempotently for UI and model search', async () => {
    const created = await registry().createSession({ name: 'Search source' })
    const event: SessionIndexEvent = {
      eventId: crypto.randomUUID(),
      type: 'message',
      entryId: 'message-1',
      entrySeq: 1,
      role: 'user',
      timestamp: new Date().toISOString(),
      text: 'Durable aardvark protocol notes',
    }

    await registry().applyIndexEvents(created.id, [event, event])
    const results = await registry().searchSessions({ query: 'aardvark' })

    expect(results).toHaveLength(1)
    expect(results[0].session.id).toBe(created.id)
    expect(results[0].matches).toHaveLength(1)
    expect(results[0].matches[0].text).toContain('aardvark')
  })

  it('forks before a selected user message and copies the current workspace', async () => {
    const source = await registry().createSession({ name: 'Fork source' })
    const timestamp = new Date().toISOString()
    const messageTimestamp = Date.now()
    await session(source.id).importSession({
      metadata: { id: source.id, createdAt: source.createdAt, updatedAt: timestamp, lineage: { type: 'new' } },
      entries: [
        { type: 'message', id: 'user-1', parentId: null, timestamp, message: { role: 'user', content: 'First prompt', timestamp: messageTimestamp } },
        { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }], api: 'openai-completions', provider: 'test', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: messageTimestamp } },
        { type: 'message', id: 'user-2', parentId: 'assistant-1', timestamp, message: { role: 'user', content: 'Fork this prompt', timestamp: messageTimestamp } },
      ],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      files: [{ path: '/notes.txt', content: 'current workspace' }],
    })

    const forked = await registry().forkSession({ sourceSessionId: source.id, entryId: 'user-2', name: 'Forked' })
    const branch = await session(forked.id).getBranch()

    expect(branch.entries.filter(({ type }) => type === 'message').map(({ id }) => id)).toEqual(['user-1', 'assistant-1'])
    expect((await session(forked.id).readWorkspaceFile('/notes.txt')).content).toBe('current workspace')
    expect((await session(forked.id).getOverview()).lineage).toEqual({
      type: 'fork',
      parentSessionId: source.id,
      sourceEntryId: 'user-2',
    })
  })

  it('tombstones and removes deleted sessions from discovery', async () => {
    const created = await registry().createSession({ name: 'Delete me' })
    await registry().deleteSession(created.id)

    expect((await registry().listSessions()).some(({ id }) => id === created.id)).toBe(false)
  })

  it('keeps global memory after its source session is deleted', async () => {
    const source = await registry().createSession({ name: 'Memory source' })
    const memory = await registry().setMemory({
      kind: 'preference',
      content: `Prefers concise test responses ${source.id}`,
      sourceSessionId: source.id,
    })

    await registry().deleteSession(source.id)

    expect((await registry().listMemories()).some(({ id }) => id === memory.id)).toBe(true)
    await registry().deleteMemory(memory.id)
  })

  it('applies extracted memory idempotently from an indexed source entry', async () => {
    const source = await registry().createSession({ name: 'Extraction source' })
    const entryId = crypto.randomUUID()
    await registry().applyIndexEvents(source.id, [{
      eventId: crypto.randomUUID(),
      type: 'message',
      entryId,
      entrySeq: 1,
      role: 'user',
      timestamp: new Date().toISOString(),
      text: 'I prefer deterministic memory tests.',
    }])
    const input = {
      extractionId: crypto.randomUUID(),
      sessionId: source.id,
      throughRevision: 1,
      operations: [{
        action: 'add' as const,
        kind: 'preference' as const,
        content: `Prefers deterministic memory tests ${source.id}`,
        sourceEntryId: entryId,
      }],
    }

    await registry().applyMemoryExtraction(input)
    await registry().applyMemoryExtraction(input)

    const matches = (await registry().listMemories()).filter(({ content }) => content === input.operations[0].content)
    expect(matches).toHaveLength(1)
    await registry().deleteMemory(matches[0].id)
  })

})
