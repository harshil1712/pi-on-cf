import { describe, expect, it } from 'vitest'
import { reduceRunStatus } from '~/lib/run-status'
import { runEnd, runStart, snapshot, unanswered } from '../pi-views'

describe('reduceRunStatus', () => {
  it('follows the live run state', () => {
    expect(reduceRunStatus('idle', [runStart])).toBe('running')
    expect(reduceRunStatus('running', [runEnd])).toBe('idle')
  })

  it('reads a persisted run failure, including after a reconnect, until the next run', () => {
    expect(reduceRunStatus('running', [runEnd, unanswered('model_error')])).toBe('failed')
    expect(reduceRunStatus('idle', [unanswered('model_error')])).toBe('failed')
    expect(reduceRunStatus('failed', [runStart])).toBe('running')
  })

  it('does not count an abort as a failure', () => {
    expect(reduceRunStatus('running', [runEnd, unanswered('aborted')])).toBe('idle')
  })

  it('takes a pending run from a view, and clears a stale running one', () => {
    expect(reduceRunStatus('idle', [snapshot([], { run: {} })])).toBe('running')
    expect(reduceRunStatus('running', [snapshot([])])).toBe('idle')
  })
})
