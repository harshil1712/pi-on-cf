import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { Memory, MemoryKind } from '../shared/pi-contract'

type MemoryRegistry = {
  setMemory(input: {
    id?: string
    kind: MemoryKind
    content: string
    sourceSessionId?: string
  }): Promise<Memory>
  deleteMemory(id: string): Promise<void>
}

const parameters = Type.Union([
  Type.Object({
    action: Type.Literal('set'),
    id: Type.Optional(Type.String({ description: 'Existing memory ID when correcting a memory' })),
    kind: Type.Union([
      Type.Literal('preference'),
      Type.Literal('fact'),
      Type.Literal('instruction'),
      Type.Literal('decision'),
    ]),
    content: Type.String({ description: 'One concise, durable fact. Never include secrets or conversation excerpts.' }),
  }),
  Type.Object({
    action: Type.Literal('delete'),
    id: Type.String({ description: 'Memory ID shown in LONG-TERM MEMORY' }),
  }),
])

export function createMemoryTool(registry: MemoryRegistry, sessionId: string): AgentHarnessTool<undefined, typeof parameters> {
  return {
    name: 'memory',
    label: 'Update memory',
    description: 'Set, correct, or delete long-term memory only when the user directly asks to remember, save, correct, or forget something. Do not call this for ordinary statements of fact or preference.',
    parameters,
    executionMode: 'sequential',
    execute: async (_id, input, signal) => {
      signal?.throwIfAborted()
      if (input.action === 'delete') {
        await registry.deleteMemory(input.id)
        signal?.throwIfAborted()
        return result(`Deleted memory ${input.id}`)
      }
      const memory = await registry.setMemory({
        id: input.id,
        kind: input.kind,
        content: input.content,
        sourceSessionId: sessionId,
      })
      signal?.throwIfAborted()
      return result(`Stored memory ${memory.id}`)
    },
  }
}

function result(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}
