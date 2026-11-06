import type { ConversationView, LiveState } from '@earendil-works/pi-durable'

/** Whether a session is working, as the catalog lists it. `failed` sticks until the next run starts. */
export type RunStatus = 'idle' | 'running' | 'failed'

/** The live document in a conversation view, typed by pi-durable's built-in `pi.live` definition. */
export function liveState(view: Pick<ConversationView, 'docs'>): LiveState {
  // SAFETY: ConversationView.docs holds pi-durable's built-in documents; `pi.live` is its LiveState document.
  return (view.docs['pi.live'] ?? {}) as LiveState
}

/**
 * Why the latest run ended without an answer. An abort is the user's doing,
 * not a failure; the other reasons are model, storage, restart, or task failures.
 */
export function unansweredReason(view: Pick<ConversationView, 'docs'>): string | undefined {
  const { reason } = liveState(view).runFailure ?? {}

  return reason === undefined || reason === 'aborted' ? undefined : reason
}

/** Fold conversation views into a run status. Each view carries both pending work and the latest run failure. */
export function reduceRunStatus(status: RunStatus, views: readonly Pick<ConversationView, 'docs'>[]): RunStatus {
  return views.reduce(reduceRunStatusView, status)
}

function reduceRunStatusView(_status: RunStatus, view: Pick<ConversationView, 'docs'>): RunStatus {
  if (liveState(view).run !== undefined) return 'running'

  return unansweredReason(view) ? 'failed' : 'idle'
}
