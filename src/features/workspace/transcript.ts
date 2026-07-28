import type { PiStreamEvent, StoredSessionEntry } from '../../shared/pi-contract'

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const value = message as { content?: unknown }
  if (typeof value.content === 'string') return value.content
  if (!Array.isArray(value.content)) return ''
  return value.content
    .filter((part): part is { type: string; text: string } => {
      return Boolean(part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part)
    })
    .map((part) => part.text)
    .join('')
}

export type TranscriptEntry =
  | { id: string; type: 'message'; role: 'user' | 'assistant'; text: string }
  | { id: string; type: 'reasoning'; text: string; status: 'running' | 'complete' }
  | { id: string; type: 'tool'; callId: string; name: string; args: unknown; status: 'running' | 'complete' | 'error' }

export type TranscriptState = {
  entries: TranscriptEntry[]
  activeTextId: string
  activeReasoningId: string
}

export function transcriptEntries(stored: StoredSessionEntry[] | unknown[]): TranscriptEntry[] {
  const messages = stored.map((entry, index) => {
    if (entry && typeof entry === 'object' && 'id' in entry && 'type' in entry) {
      const value = entry as StoredSessionEntry
      return { message: value.message, stableId: value.id, type: value.type, summary: value.summary }
    }
    return { message: entry, stableId: `stored-${index}`, type: 'message', summary: undefined }
  })
  const toolResults = new Map<string, boolean>()
  for (const { message } of messages) {
    if (!message || typeof message !== 'object') continue
    const value = message as { role?: string; toolCallId?: unknown; isError?: unknown }
    if (value.role === 'toolResult' && typeof value.toolCallId === 'string') {
      toolResults.set(value.toolCallId, value.isError === true)
    }
  }

  return messages.flatMap(({ message, stableId, type, summary }): TranscriptEntry[] => {
    if ((type === 'compaction' || type === 'branch_summary') && summary) {
      return [{ id: stableId, type: 'reasoning', text: summary, status: 'complete' }]
    }
    if (!message || typeof message !== 'object') return []
    const value = message as { role?: string; content?: unknown }
    if (value.role === 'user') {
      const text = messageText(value)
      return text ? [{ id: stableId, type: 'message', role: 'user', text }] : []
    }
    if (value.role !== 'assistant' || !Array.isArray(value.content)) return []

    return value.content.flatMap((part, partIndex): TranscriptEntry[] => {
      if (!part || typeof part !== 'object' || !('type' in part)) return []
      const id = `${stableId}-${partIndex}`
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string' && part.text) {
        return [{ id, type: 'message', role: 'assistant', text: part.text }]
      }
      if (part.type === 'thinking' && 'thinking' in part && typeof part.thinking === 'string' && part.thinking) {
        return [{ id, type: 'reasoning', text: part.thinking, status: 'complete' }]
      }
      if (part.type === 'toolCall' && 'id' in part && typeof part.id === 'string' && 'name' in part && typeof part.name === 'string') {
        return [{
          id,
          type: 'tool',
          callId: part.id,
          name: part.name,
          args: 'arguments' in part ? part.arguments : {},
          status: toolResults.get(part.id) ? 'error' : 'complete',
        }]
      }
      return []
    })
  })
}

export function reduceStreamEvent(
  state: TranscriptState,
  event: PiStreamEvent,
  createId: () => string = () => crypto.randomUUID(),
): TranscriptState {
  if (event.type === 'text_start') {
    const id = createId()
    return { ...state, activeTextId: id, entries: [...state.entries, { id, type: 'message', role: 'assistant', text: '' }] }
  }
  if (event.type === 'text_delta') {
    if (!state.activeTextId) {
      const id = createId()
      return {
        ...state,
        activeTextId: id,
        entries: [...state.entries, { id, type: 'message', role: 'assistant', text: event.delta }],
      }
    }
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry.type === 'message' && entry.id === state.activeTextId ? { ...entry, text: entry.text + event.delta } : entry),
    }
  }
  if (event.type === 'text_end') return { ...state, activeTextId: '' }
  if (event.type === 'thinking_start') {
    const id = createId()
    return {
      ...state,
      activeReasoningId: id,
      entries: [...state.entries, { id, type: 'reasoning', text: '', status: 'running' }],
    }
  }
  if (event.type === 'thinking_delta') {
    if (!state.activeReasoningId) {
      const id = createId()
      return {
        ...state,
        activeReasoningId: id,
        entries: [...state.entries, { id, type: 'reasoning', text: event.delta, status: 'running' }],
      }
    }
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry.type === 'reasoning' && entry.id === state.activeReasoningId
          ? { ...entry, text: entry.text + event.delta }
          : entry),
    }
  }
  if (event.type === 'thinking_end') {
    return {
      ...state,
      activeReasoningId: '',
      entries: state.entries.map((entry) =>
        entry.type === 'reasoning' && entry.id === state.activeReasoningId ? { ...entry, status: 'complete' } : entry),
    }
  }
  if (event.type === 'tool_execution_start') {
    return {
      ...state,
      entries: [...state.entries, {
        id: `tool-${event.callId}`,
        type: 'tool',
        callId: event.callId,
        name: event.name,
        args: event.args,
        status: 'running',
      }],
    }
  }
  if (event.type === 'tool_execution_end') {
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry.type === 'tool' && entry.callId === event.callId
          ? { ...entry, status: event.isError ? 'error' : 'complete' }
          : entry),
    }
  }
  if (event.type === 'done') {
    return {
      ...state,
      activeReasoningId: '',
      activeTextId: '',
      entries: state.entries.map((entry) =>
        entry.type === 'reasoning' && entry.status === 'running' ? { ...entry, status: 'complete' } : entry),
    }
  }
  return state
}
