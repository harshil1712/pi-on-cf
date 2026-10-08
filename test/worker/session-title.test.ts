import { describe, expect, it } from 'vitest'
import { titleFromPrompt } from '~/server/session-title'

describe('titleFromPrompt', () => {
  it('keeps a short prompt as it is', () => {
    expect(titleFromPrompt('Fix the login bug')).toBe('Fix the login bug')
  })

  it('uses the first line that is not empty', () => {
    expect(titleFromPrompt('\n  \nAdd a README\nwith install steps')).toBe('Add a README')
  })

  it('collapses whitespace', () => {
    expect(titleFromPrompt('  Review\t@octo/demo   and   report  ')).toBe('Review @octo/demo and report')
  })

  it('cuts a long prompt at a word boundary', () => {
    const title = titleFromPrompt('Refactor the session registry so that every catalog entry carries its own title and summary')
    expect(title).toBe('Refactor the session registry so that every catalog entry…')
    expect(title.length).toBeLessThanOrEqual(61)
  })

  it('hard-cuts a single word longer than the limit', () => {
    expect(titleFromPrompt('x'.repeat(100))).toBe(`${'x'.repeat(60)}…`)
  })
})
