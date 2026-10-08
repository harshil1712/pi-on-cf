import type { AgentEvent } from '@earendil-works/pi-durable'

/**
 * Whether a session is working, as the catalog lists it. `failed` sticks
 * until the next run starts.
 */
export type RunStatus = 'idle' | 'running' | 'failed'

/**
 * Why pi gave up on an input, from a `submission` event: every failed run
 * (a model error, a faulted or orphaned task, no model) settles its inputs
 * `unanswered` in the same commit as its `run_end`. An abort or a withdrawn
 * steer is the user's doing, not a failure.
 */
export function unansweredReason(event: AgentEvent): string | undefined {
  if (event.type !== 'submission' || event.record.status !== 'unanswered') return undefined
  const { reason } = event.record
  return reason === 'aborted' || reason === 'withdrawn' ? undefined : reason
}

/**
 * Fold pi's agent events into a run status, as the browser's transcript
 * reducer folds `running`. A snapshot tells whether a run is pending, not
 * how the last one ended, so it keeps a `failed`.
 */
export function reduceRunStatus(status: RunStatus, events: readonly AgentEvent[]): RunStatus {
  return events.reduce(reduceRunStatusEvent, status)
}

function reduceRunStatusEvent(status: RunStatus, event: AgentEvent): RunStatus {
  switch (event.type) {
    case 'snapshot':
      if (event.run !== undefined) return 'running'
      return status === 'running' ? 'idle' : status
    case 'run_start':
      return 'running'
    case 'run_end':
      // Its failure, if any, follows in the same batch as a `submission`.
      return status === 'running' ? 'idle' : status
    default:
      // A run's own inputs settle after its `run_end`; one settled while a
      // run goes on (a stale queued write) does not stop that run.
      return status !== 'running' && unansweredReason(event) ? 'failed' : status
  }
}
