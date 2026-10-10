import { describe, expect, it } from 'vitest'
import { registry, session } from './stubs'

describe('web tools', () => {
  it('reads a page with web_fetch through pi', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    const result = await pi.promptForTest('tool web_fetch {"url":"https://example.com/notes"}')
    expect(result.status).toBe('done')
    expect(result.text).toMatch(/^tool said: web_fetch: https:\/\/example\.com\/notes · 200/)
    expect(result.text).toContain('Hello from the fake source')
    expect(result.kinds).toContain('pi.tool-result')
  })

  it('finds pages with web_search through pi', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    const result = await pi.promptForTest('tool web_search {"query":"kittens"}')
    expect(result.text).toContain('https://example.com/kittens')
    expect(result.text).toContain('Kittens')
  })

  it('has no browser tabs without a BROWSER binding', async () => {
    const { id } = await registry().createSession()
    expect(await (await session(id)).browserLiveView()).toBeNull()
  })
})
