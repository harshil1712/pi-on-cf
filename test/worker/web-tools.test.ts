import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PiRegistry as TestPiRegistry, PiSession as TestPiSession } from './entry'

const registry = () => env.PiRegistry.getByName('singleton') as unknown as DurableObjectStub<TestPiRegistry>

async function session(id: string): Promise<DurableObjectStub<TestPiSession>> {
  const name = await registry().sessionAgentNameForTest(id)
  if (!name) throw new Error(`No session behind ${id}`)
  return env.PiSession.getByName(name) as unknown as DurableObjectStub<TestPiSession>
}

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

  it('offers the web tools a deployment has bindings and vars for', async () => {
    const { id } = await registry().createSession()
    const pi = await session(id)
    // The test environment has no AI binding, so without overrides there are none.
    expect(await pi.webToolNamesForTest({})).toEqual([])
    expect(await pi.webToolNamesForTest({ AI: true })).toEqual(['web_fetch'])
    // Search needs its provider and its key alias, and the provider must be one of the three.
    expect(await pi.webToolNamesForTest({ AI: true, WEB_SEARCH_PROVIDER: 'exa' })).toEqual(['web_fetch'])
    expect(await pi.webToolNamesForTest({ AI: true, WEB_SEARCH_PROVIDER: 'llama', WEB_SEARCH_BYOK_ALIAS: 'x' })).toEqual(['web_fetch'])
    expect(await pi.webToolNamesForTest({ AI: true, WEB_SEARCH_PROVIDER: 'exa', WEB_SEARCH_BYOK_ALIAS: 'x' })).toEqual(['web_fetch', 'web_search'])
    // The browser needs its binding.
    expect(await pi.webToolNamesForTest({ BROWSER: {} })).toEqual(['browser'])
    expect(await pi.webToolNamesForTest({ AI: true, BROWSER: {} })).toEqual(['web_fetch', 'browser'])
  })

  it('has no browser tabs without a BROWSER binding', async () => {
    const { id } = await registry().createSession()
    expect(await (await session(id)).browserLiveView()).toBeNull()
  })
})
