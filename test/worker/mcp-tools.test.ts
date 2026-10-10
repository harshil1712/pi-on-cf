import { describe, expect, it } from 'vitest'
import { connectorHint, connectorNames } from '~/server/mcp-tools'
import type { McpServerCatalog } from '~/server/mcp-servers'
import { registry, session } from './stubs'

/** What the faux model sends to call the `mcp` tool with `code`. */
const callMcp = (code: string) => `tool mcp ${JSON.stringify({ code })}`

describe('the mcp tool', () => {
  it('calls an enabled server\'s tool through the registry', async () => {
    await registry().connectTestMcpServerForTest('Arith')
    const { id } = await registry().createSession()
    const result = await (await session(id)).promptForTest(callMcp('async () => arith.add({ a: 2, b: 3 })'))
    expect(result.status).toBe('done')
    expect(result.text).toMatch(/^tool said: /)
    expect(result.text).toMatch(/"result":5/)
  })

  it('finds tools with codemode.search', async () => {
    await registry().connectTestMcpServerForTest('Finder')
    const { id } = await registry().createSession()
    const result = await (await session(id)).promptForTest(callMcp('async () => (await codemode.search("add two numbers")).results.map((r) => r.path)'))
    expect(result.text).toContain('finder.add')
  })

  it('reports a failing tool as an error the model sees', async () => {
    await registry().connectTestMcpServerForTest('Breaker')
    const { id } = await registry().createSession()
    const result = await (await session(id)).promptForTest(callMcp('async () => breaker.fail({})'))
    expect(result.text).toMatch(/^tool failed: /)
    expect(result.text).toContain('it broke')
  })

  it('drops a server from the next sync once it is disabled', async () => {
    const serverId = await registry().connectTestMcpServerForTest('Toggled')
    const { id } = await registry().createSession()
    const pi = await session(id)
    await registry().setMcpServerEnabled(serverId, false)
    expect(await pi.syncMcpToolsForTest()).toBe(true)
    const result = await pi.promptForTest(callMcp('async () => toggled.add({ a: 1, b: 1 })'))
    expect(result.text).toMatch(/^tool failed: /)
    expect(result.text).not.toMatch(/"result":2/)
    // Nothing changed since, so the next sync is a no-op.
    expect(await pi.syncMcpToolsForTest()).toBe(false)
  })
})

describe('connectorNames', () => {
  const server = (name: string): McpServerCatalog => ({ id: name, name, tools: [] })

  it('lowercases and sanitizes names, and makes them unique', () => {
    expect(connectorNames([server('Cloudflare Docs'), server('cloudflare-docs'), server('codemode'), server('2fa')]).map(({ name }) => name))
      .toEqual(['cloudflare_docs', 'cloudflare_docs_2', 'codemode_2', '_2fa'])
  })
})

describe('connectorHint', () => {
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })

  it('names a small server\'s tools', () => {
    expect(connectorHint({ id: 'docs', name: 'Cloudflare Docs', tools: [tool('search_cloudflare_documentation'), tool('migrate-pages')] }))
      .toBe('The "Cloudflare Docs" MCP server: search_cloudflare_documentation, migrate_pages.')
  })

  it('names the first twenty of a large server\'s tools', () => {
    const hint = connectorHint({ id: 'big', name: 'Big', tools: Array.from({ length: 25 }, (_, i) => tool(`t${i}`)) })
    expect(hint).toMatch(/t19, and 5 more\.$/)
    expect(hint).not.toContain('t20')
  })
})
