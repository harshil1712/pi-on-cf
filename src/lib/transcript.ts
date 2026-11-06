import type { AssistantMessage, JsonObject, Message } from '@earendil-works/pi-ai'
import type { EntryRecord, InboxState, ToolSlot, TranscriptView } from '@earendil-works/pi-durable'
import { liveState, unansweredReason } from './run-status'

export type TranscriptEntry =
  | { id: string; type: 'message'; role: 'user' | 'assistant'; text: string }
  | { id: string; type: 'reasoning'; text: string; status: 'running' | 'complete' }
  | { id: string; type: 'summary'; kind: 'compaction' | 'reset'; text: string; status: 'complete' }
  | { id: string; type: 'tool'; callId: string; name: string; args: JsonObject; result?: string; images?: TranscriptImage[]; status: 'running' | 'complete' | 'error' }

/** An image a tool returns, as a data URL the card can show. */
export type TranscriptImage = { alt: string; src: string }

/** A tool call in the current round, with its retained output. */
type ToolProgress = { name: string; output: string; status: ToolSlot['status'] }

/** One session as the browser sees it: committed transcript entries plus Pi's live state. */
export type PiView = {
  entries: readonly EntryRecord[]
  live: AssistantMessage | null
  tools: Readonly<Record<string, ToolProgress>>
  running: boolean
  queued: number
  error: string
  /** Increments when a tool result or run completion may have changed the workspace. */
  workspaceVersion: number
}

export const EMPTY_VIEW: PiView = { entries: [], live: null, tools: {}, running: false, queued: 0, error: '', workspaceVersion: 0 }

/** Project one complete conversation view. Unlike the old event stream, every value is authoritative state. */
export function reducePiView(current: PiView, next: TranscriptView): PiView {
  const live = liveState(next)
  const entries = next.items.flatMap((item) => item.kind === 'entry' ? [item.entry] : [])

  const tools = Object.fromEntries((live.tools ?? []).map((slot) => [slot.callId, {
    name: slot.name,
    output: slot.output ?? '',
    status: slot.status,
  }]))

  const running = live.run !== undefined

  // SAFETY: ConversationView.docs holds pi-durable's built-in documents; `pi.inbox` is its InboxState document.
  const inbox = next.docs['pi.inbox'] as InboxState | undefined

  const reason = unansweredReason(next)

  const workspaceChanged = hasNewToolResult(current, entries)
    || Object.entries(tools).some(([id, tool]) => tool.status === 'done' && current.tools[id] !== undefined && current.tools[id]?.status !== 'done')
    || (current.running && !running)

  return {
    entries,
    live: live.generation?.message ?? null,
    tools,
    running,
    queued: inbox?.items.length ?? 0,
    error: reason ? `Pi could not answer: ${reason}` : (live.compactionFailure?.error ?? ''),
    workspaceVersion: current.workspaceVersion + (workspaceChanged ? 1 : 0),
  }
}

function hasNewToolResult(current: PiView, entries: readonly EntryRecord[]): boolean {
  const known = new Set(current.entries.map((entry) => entry.id))

  return entries.some((entry) => !known.has(entry.id) && entry.model?.[0]?.role === 'toolResult')
}

export function messageText(message: Pick<Message, 'content'> | undefined): string {
  if (!message) return ''

  if (!Array.isArray(message.content)) return message.content

  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** Display rows, and the ID of the text row still streaming, or ''. */
export type Transcript = { entries: TranscriptEntry[]; activeTextId: string }

type ToolResultRow = { text: string; isError: boolean; images: TranscriptImage[] }

/** A tool result's text apart from its images: the browser tool's screenshot comes back as both. */
function toolResult(message: Extract<Message, { role: 'toolResult' }>): ToolResultRow {
  if (!Array.isArray(message.content)) return { text: messageText(message), isError: message.isError, images: [] }
  const texts: string[] = []
  const images: TranscriptImage[] = []

  for (const part of message.content) {
    if (part.type === 'text') texts.push(part.text)
    else if (part.type === 'image') {
      // The text beside it is the tool's JSON output, not a caption.
      images.push({ alt: 'Screenshot', src: part.data.startsWith('data:') ? part.data : `data:${part.mimeType};base64,${part.data}` })
    }
  }

  return { text: texts.join(''), isError: message.isError, images }
}

/** The transcript as display rows, with the streaming message last. */
export function transcriptEntries(view: PiView): Transcript {
  const results = new Map<string, ToolResultRow>()

  for (const entry of view.entries) {
    const message = entry.model?.[0]

    if (message?.role === 'toolResult') results.set(message.toolCallId, toolResult(message))
  }

  const rows: TranscriptEntry[] = []

  for (const entry of view.entries) {
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
  results: Map<string, ToolResultRow>,
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
      const progress = view.tools[part.id]

      return [{
        id: `tool-${part.id}`,
        type: 'tool',
        callId: part.id,
        name: part.name,
        args: part.arguments,
        result: result?.text ?? (progress?.output || undefined),
        images: result && result.images.length > 0 ? result.images : undefined,
        status: result
          ? (result.isError ? 'error' : 'complete')
          : progress?.status === 'done'
            ? 'error'
            : progress || view.running ? 'running' : 'error',
      }]
    }

    return []
  })
}
