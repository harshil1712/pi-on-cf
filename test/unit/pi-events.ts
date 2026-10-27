import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentEvent, ConversationId, EntryId, EntryRecord, SnapshotEvent, SubmissionId } from '@earendil-works/pi-durable'

/** Fixtures for pi-durable's agent events, as a PiSession connection delivers them. */

/** pi-durable's IDs are branded numbers, minted by its storage; tests make them from plain ones. */
export const entryId = (id: number) => id as EntryId

export const submissionId = (id: number) => id as SubmissionId

export const CONVERSATION = 1 as ConversationId

export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

export function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'faux', provider: 'faux', model: 'faux', usage, stopReason, timestamp: 0 }
}

/** A transcript entry of `kind`, holding `message` when it is one the model sees. */
export function entry(id: number, kind: string, message?: Message): EntryRecord {
  const record: EntryRecord = { id: entryId(id), conversationId: CONVERSATION, kind }

  return message ? { ...record, model: [message] } : record
}

export function snapshot(entries: readonly EntryRecord[], extra: Partial<SnapshotEvent> = {}): SnapshotEvent {
  return { type: 'snapshot', entries, tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...extra }
}

export const runStart: AgentEvent = { type: 'run_start', inputs: [] }

export const runEnd: AgentEvent = { type: 'run_end', inputs: [] }

/** An input pi will not answer, and why. */
export function unanswered(reason: string): AgentEvent {
  return { type: 'submission', record: { id: submissionId(1), conversationId: CONVERSATION, type: 'input', status: 'unanswered', reason } }
}

/** The inbox now holds these steering inputs. */
export function inboxUpdate(...ids: number[]): AgentEvent {
  return { type: 'inbox_update', items: ids.map((id) => ({ id: submissionId(id), mode: 'steer' })) }
}
