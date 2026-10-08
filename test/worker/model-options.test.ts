import { describe, expect, it } from 'vitest'
import { MODEL_OPTIONS, modelOptions } from '~/server/models'

describe('modelOptions', () => {
  it('leads with the default, so a page with no session can preselect it', () => {
    const options = modelOptions('@cf/moonshotai/kimi-k2.6')
    expect(options[0]).toEqual({ id: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6' })
    expect(options).toHaveLength(MODEL_OPTIONS.length)
    expect(new Set(options.map(({ id }) => id)).size).toBe(options.length)
  })

  it('adds a default the curated list lacks', () => {
    const options = modelOptions('@cf/example/other')
    expect(options[0]).toEqual({ id: '@cf/example/other', label: '@cf/example/other' })
    expect(options).toHaveLength(MODEL_OPTIONS.length + 1)
  })
})
