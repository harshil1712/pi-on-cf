import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, EntryRecord, InboxItem, LiveRun, LiveState, RunFailureReason, SubmissionId, TaskId, TranscriptView } from '@earendil-works/pi-durable'

/** Fixtures for pi-durable's conversation views, as a PiSession connection delivers them. */

/** pi-durable's IDs are branded numbers, minted by its storage; tests make them from plain ones. */
export const entryId = (id: number) => id as EntryId

export const submissionId = (id: number) => id as SubmissionId

export const taskId = (id: number) => id as TaskId

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

export const liveRun = (extra: Partial<LiveRun> = {}): LiveRun => ({ taskId: taskId(1), inputs: [], turns: 0, ...extra })

type ViewGeneration = Omit<NonNullable<LiveState['generation']>, 'message'> & { message?: AssistantMessage }

type SnapshotExtra = Omit<Partial<LiveState>, 'run' | 'generation'> & {
  run?: Partial<LiveRun>
  generation?: ViewGeneration
  inbox?: InboxItem[]
}

/** A complete renderer view, with `pi.live` fields supplied directly in `extra`. */
export function snapshot(entries: readonly EntryRecord[], extra: SnapshotExtra = {}): TranscriptView {
  const { inbox = [], run, generation, ...rest } = extra
  const live = { ...rest, ...(run ? { run: liveRun(run) } : {}), ...(generation ? { generation } : {}) } as LiveState

  return {
    conversation: { id: CONVERSATION },
    items: entries.map((entry) => ({ kind: 'entry', entry })),
    docs: { 'pi.live': live, 'pi.inbox': { items: inbox } },
  }
}

export const runStart: TranscriptView = snapshot([], { run: {} })

export const runEnd: TranscriptView = snapshot([])

/** A run that ended without an answer, and why. */
export function unanswered(reason: RunFailureReason): TranscriptView {
  return snapshot([], { runFailure: { taskId: taskId(1), inputs: [submissionId(1)], reason } })
}

/** Queued inputs for a later view's `pi.inbox`. */
export function inboxItems(...ids: number[]): InboxItem[] {
  return ids.map((id) => ({ id: submissionId(id), mode: 'steer', content: 'Queued prompt' }))
}
