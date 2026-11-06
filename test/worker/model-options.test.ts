import { describe, expect, it } from 'vitest'
import { MODEL_OPTIONS, modelOptions } from '~/server/models'

describe('modelOptions', () => {
  it('leads with the default, so a page with no session can preselect it', () => {
    const options = modelOptions('@cf/deepseek-ai/deepseek-v4.1-flash-1017')
    expect(options[0]).toEqual({ id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' })
    expect(options).toHaveLength(MODEL_OPTIONS.length)
    expect(new Set(options.map(({ id }) => id)).size).toBe(options.length)
  })

  it('adds a default the curated list lacks', () => {
    const options = modelOptions('@cf/example/other')
    expect(options[0]).toEqual({ id: '@cf/example/other', label: '@cf/example/other' })
    expect(options).toHaveLength(MODEL_OPTIONS.length + 1)
  })
})
