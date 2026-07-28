import { describe, expect, it } from 'vitest'
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core'
import { prepareManualCompaction } from './manual-compaction'

describe('prepareManualCompaction', () => {
  it('summarizes available history instead of retaining a short conversation in full', () => {
    const timestamp = new Date().toISOString()
    const userEntry: Extract<SessionTreeEntry, { type: 'message' }> = {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp,
      message: { role: 'user', content: 'Create a Worker', timestamp: Date.now() },
    }
    const assistantEntry: Extract<SessionTreeEntry, { type: 'message' }> = {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Created it.' }],
        api: 'openai-completions',
        provider: 'test',
        model: 'test',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    }
    const entries: SessionTreeEntry[] = [userEntry, assistantEntry]

    const result = prepareManualCompaction(entries, {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok || !result.value) return
    expect(result.value.turnPrefixMessages).toEqual([userEntry.message])
    expect(result.value.retainedTail).toEqual([assistantEntry.message])
  })
})
