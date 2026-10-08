import type { AgentEvent, SnapshotEvent } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { reduceRunStatus } from '~/lib/run-status'

const snapshot = (overrides: Partial<SnapshotEvent> = {}): AgentEvent => ({
  type: 'snapshot', entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: {}, ...overrides,
} as unknown as AgentEvent)
const unanswered = (reason: string): AgentEvent => ({ type: 'submission', record: { status: 'unanswered', reason } } as unknown as AgentEvent)
const runStart = { type: 'run_start', inputs: [] } as unknown as AgentEvent
const runEnd = { type: 'run_end', inputs: [] } as unknown as AgentEvent

describe('reduceRunStatus', () => {
  it('runs from run_start to run_end', () => {
    expect(reduceRunStatus('idle', [runStart])).toBe('running')
    expect(reduceRunStatus('running', [runEnd])).toBe('idle')
  })

  it('fails when pi gives up on the run\'s inputs, until the next run starts', () => {
    const failed = reduceRunStatus('running', [runEnd, unanswered('model_error')])
    expect(failed).toBe('failed')
    expect(reduceRunStatus(failed, [snapshot()])).toBe('failed')
    expect(reduceRunStatus(failed, [runStart])).toBe('running')
  })

  it('does not count an abort as a failure', () => {
    expect(reduceRunStatus('running', [runEnd, unanswered('aborted')])).toBe('idle')
  })

  it('takes a pending run from the snapshot, and clears a stale running one', () => {
    expect(reduceRunStatus('idle', [snapshot({ run: { inputs: [] } })])).toBe('running')
    expect(reduceRunStatus('running', [snapshot()])).toBe('idle')
  })
})
