import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord, MessageChange } from '@earendil-works/pi-durable'

export type TranscriptEntry =
  | { id: string; type: 'message'; role: 'user' | 'assistant'; text: string }
  | { id: string; type: 'reasoning'; text: string; status: 'running' | 'complete' }
  | { id: string; type: 'summary'; kind: 'compaction' | 'reset'; text: string; status: 'complete' }
  | { id: string; type: 'tool'; callId: string; name: string; args: unknown; result?: unknown; status: 'running' | 'complete' | 'error' }

/** A tool call pi is running now, with its retained output. */
type RunningTool = { name: string; output: string }

/**
 * One session as the browser sees it, folded from pi-durable's agent
 * events: the committed active transcript plus what is streaming now.
 */
export type PiView = {
  entries: readonly EntryRecord[]
  live: AssistantMessage | null
  tools: Readonly<Record<string, RunningTool>>
  running: boolean
  queued: number
  error: string
}

export const EMPTY_VIEW: PiView = { entries: [], live: null, tools: {}, running: false, queued: 0, error: '' }

export function reducePiEvents(view: PiView, events: readonly AgentEvent[]): PiView {
  return events.reduce(reducePiEvent, view)
}

function reducePiEvent(view: PiView, event: AgentEvent): PiView {
  switch (event.type) {
    case 'snapshot':
      return {
        entries: event.entries,
        live: event.generation?.message ?? null,
        tools: Object.fromEntries(event.tools
          .filter((slot) => slot.status !== 'done')
          .map((slot) => [slot.callId, { name: slot.name, output: slot.output ?? '' }])),
        running: event.run !== undefined,
        queued: event.inbox.length,
        error: '',
      }
    case 'run_start':
      return { ...view, running: true, error: '' }
    case 'run_end':
      return { ...view, running: false, live: null, tools: {} }
    case 'message_start':
      return event.message.role === 'assistant' ? { ...view, live: event.message } : view
    case 'message_update':
      return view.live ? { ...view, live: applyChanges(view.live, event.changes) } : view
    case 'message_end': {
      const next = append(view, event.entry)
      return event.entry.model?.[0]?.role === 'assistant' ? { ...next, live: null } : next
    }
    case 'entry_appended':
      return append(view, event.entry)
    case 'tool_execution_start':
      return { ...view, tools: { ...view.tools, [event.toolCallId]: { name: event.toolName, output: '' } } }
    case 'tool_execution_update': {
      const tool = view.tools[event.toolCallId]
      if (!tool || !event.output) return view
      const output = 'set' in event.output
        ? event.output.set
        : tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? '')
      return { ...view, tools: { ...view.tools, [event.toolCallId]: { ...tool, output } } }
    }
    case 'tool_execution_end': {
      const { [event.toolCallId]: _finished, ...tools } = view.tools
      const next = { ...view, tools }
      return event.entry ? append(next, event.entry) : next
    }
    case 'inbox_update':
      return { ...view, queued: event.items.length }
    case 'task_failed':
      return { ...view, error: event.message }
    case 'submission':
      return event.record.status === 'unanswered' && event.record.reason !== 'aborted' && event.record.reason !== 'withdrawn'
        ? { ...view, error: `Pi could not answer: ${event.record.reason}` }
        : view
    default:
      return view
  }
}

/**
 * Add a committed entry. An entry with a `head` (a reset or a compaction)
 * starts a new active context at that entry, as pi's snapshot does.
 */
function append(view: PiView, entry: EntryRecord): PiView {
  if (view.entries.some((known) => known.id === entry.id)) return view
  if (entry.head !== undefined) {
    const head = entry.head
    return { ...view, entries: [...view.entries.filter((known) => known.id >= head && known.head === undefined), entry] }
  }
  return { ...view, entries: [...view.entries, entry] }
}

function applyChanges(message: AssistantMessage, changes: readonly MessageChange[]): AssistantMessage {
  let next = message
  for (const change of changes) {
    if (change.type === 'message') {
      next = change.message
      continue
    }
    const content = [...next.content]
    const previous = content[change.contentIndex]
    switch (change.type) {
      case 'text_start':
      case 'thinking_start':
      case 'toolcall_start':
      case 'block':
        content[change.contentIndex] = change.block as AssistantMessage['content'][number]
        break
      case 'text_delta':
        content[change.contentIndex] = { type: 'text', text: (previous?.type === 'text' ? previous.text : '') + change.delta }
        break
      case 'thinking_delta':
        content[change.contentIndex] = {
          ...(previous?.type === 'thinking' ? previous : {}),
          type: 'thinking',
          thinking: (previous?.type === 'thinking' ? previous.thinking : '') + change.delta,
        }
        break
      case 'toolcall_delta':
        // Partial argument JSON; the call renders once its block completes.
        break
    }
    next = { ...next, content }
  }
  return next
}

export function messageText(message: Pick<Message, 'content'> | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** The active transcript as display rows, with the streaming message last. */
export function transcriptEntries(view: PiView): { entries: TranscriptEntry[]; activeTextId: string } {
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const entry of view.entries) {
    const message = entry.model?.[0]
    if (message?.role === 'toolResult') {
      results.set(message.toolCallId, { text: messageText(message), isError: message.isError })
    }
  }

  const rows: TranscriptEntry[] = []
  for (const entry of headFirst(view.entries)) {
    const id = String(entry.id)
    const message = entry.model?.[0]
    if (entry.kind === 'pi.compaction') {
      rows.push({ id, type: 'summary', kind: 'compaction', text: messageText(message), status: 'complete' })
    } else if (entry.kind === 'pi.reset') {
      rows.push({ id, type: 'summary', kind: 'reset', text: messageText(message) || 'Context reset.', status: 'complete' })
    } else if (message?.role === 'user') {
      const text = messageText(message)
      if (text) rows.push({ id, type: 'message', role: 'user', text })
    } else if (message?.role === 'assistant') {
      rows.push(...assistantRows(message, id, view, results, false))
    }
  }

  let activeTextId = ''
  if (view.live) {
    const live = assistantRows(view.live, 'live', view, results, true)
    activeTextId = live.findLast((row) => row.type === 'message')?.id ?? ''
    rows.push(...live)
  }
  return { entries: rows, activeTextId }
}

function assistantRows(
  message: AssistantMessage,
  id: string,
  view: PiView,
  results: Map<string, { text: string; isError: boolean }>,
  streaming: boolean,
): TranscriptEntry[] {
  return message.content.flatMap((part, index): TranscriptEntry[] => {
    const rowId = `${id}-${index}`
    if (part.type === 'text') return part.text ? [{ id: rowId, type: 'message', role: 'assistant', text: part.text }] : []
    if (part.type === 'thinking') {
      return part.thinking ? [{ id: rowId, type: 'reasoning', text: part.thinking, status: streaming ? 'running' : 'complete' }] : []
    }
    if (part.type === 'toolCall') {
      const result = results.get(part.id)
      const running = view.tools[part.id]
      return [{
        id: `tool-${part.id}`,
        type: 'tool',
        callId: part.id,
        name: part.name,
        args: part.arguments,
        result: result?.text ?? (running?.output || undefined),
        status: result ? (result.isError ? 'error' : 'complete') : view.running ? 'running' : 'error',
      }]
    }
    return []
  })
}

/** pi lists a context's head entry (compaction or reset) after the entries it keeps; show it first. */
function headFirst(entries: readonly EntryRecord[]): readonly EntryRecord[] {
  const head = entries.findLast((entry) => entry.head !== undefined)
  return head ? [head, ...entries.filter((entry) => entry !== head)] : entries
}

