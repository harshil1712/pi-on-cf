import { describe, expect, it } from 'vitest'
import { mentionQueryAt } from '~/lib/repo-mention'

describe('mentionQueryAt', () => {
  it('reads the @query being typed before the caret', () => {
    expect(mentionQueryAt('work on @oct', 12)).toEqual({ start: 8, query: 'oct' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('@octo/de and more', 8)).toEqual({ start: 0, query: 'octo/de' })
  })

  it('is null once the mention is finished or outside one', () => {
    expect(mentionQueryAt('@octo/demo ', 11)).toBeNull()
    expect(mentionQueryAt('someone@example', 15)).toBeNull()
    expect(mentionQueryAt('plain text', 10)).toBeNull()
  })
})
