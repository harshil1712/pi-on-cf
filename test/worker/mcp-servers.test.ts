import { describe, expect, it } from 'vitest'
import { cleanMcpServerInput, type JsonObject, type McpCallResult, type McpServerCatalog } from '~/server/mcp-servers'
import type { McpServerSummary } from '~/contract'
import { errorMessage } from '~/lib/error-message'
import { registry } from './stubs'

/** The registry's MCP methods for sessions, typed directly: the stub's mapping of recursive JSON types is too deep for tsc. */
type McpRpc = {
  listMcpTools(): Promise<McpServerCatalog[]>
  callMcpTool(serverId: string, name: string, args: JsonObject): Promise<McpCallResult>
}

// The stub's RPC mapping of these recursive JSON types is too deep for tsc,
// so the registry is typed against the app's own interface here.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const mcp = () => registry() as unknown as McpRpc

/**
 * The message a registry call fails with. Settled here, since a Durable
 * Object RPC promise that `expect(...).rejects` awaits is still reported as
 * an unhandled rejection.
 */
async function failure(call: Promise<unknown>): Promise<string> {
  return call.then(() => 'no error', (cause: unknown) => errorMessage(cause))
}

/** A fresh test server under a unique name, since tests share the registry. */
async function connect(): Promise<string> {
  return registry().connectTestMcpServerForTest(`Test ${crypto.randomUUID().slice(0, 8)}`)
}

describe('MCP servers on the registry', () => {
  it('lists a connected server with its tool count, enabled', async () => {
    const id = await connect()
    const server = (await registry().listMcpServers()).find((entry) => entry.id === id)
    expect(server).toMatchObject({ id, state: 'ready', toolCount: 2, enabled: true })
    expect(server?.authUrl).toBeUndefined()
  })

  it('offers the tools of enabled servers, with their schemas and instructions', async () => {
    const id = await connect()
    const server = (await mcp().listMcpTools()).find((entry) => entry.id === id)
    expect(server?.instructions).toBe('Arithmetic for tests.')
    expect(server?.tools.map((tool) => tool.name)).toEqual(['add', 'fail'])
    const add = server?.tools[0]
    expect(add?.description).toBe('Add two numbers')
    expect(add?.inputSchema).toMatchObject({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } })
  })

  it('calls a tool and returns its result', async () => {
    const id = await connect()
    expect(await mcp().callMcpTool(id, 'add', { a: 2, b: 3 })).toEqual({ content: [{ type: 'text', text: '5' }] })
    expect(await mcp().callMcpTool(id, 'fail', {})).toEqual({ content: [{ type: 'text', text: 'it broke' }], isError: true })
  })

  it('reconnects a failed server for a call', async () => {
    const id = await connect()
    await registry().dropMcpConnectionForTest(id)
    expect(await mcp().callMcpTool(id, 'add', { a: 1, b: 1 })).toEqual({ content: [{ type: 'text', text: '2' }] })
  })

  it('hides a disabled server from sessions and refuses its calls', async () => {
    const id = await connect()
    expect((await registry().setMcpServerEnabled(id, false)).enabled).toBe(false)
    expect((await mcp().listMcpTools()).some((server) => server.id === id)).toBe(false)
    expect(await failure(mcp().callMcpTool(id, 'add', { a: 1, b: 2 }))).toMatch(/disabled/)
    await registry().setMcpServerEnabled(id, true)
    expect((await mcp().listMcpTools()).some((server) => server.id === id)).toBe(true)
  })

  it('deletes a server', async () => {
    const id = await connect()
    await registry().deleteMcpServer(id)
    expect((await registry().listMcpServers()).some((server) => server.id === id)).toBe(false)
    expect((await mcp().listMcpTools()).some((server) => server.id === id)).toBe(false)
    expect(await failure(mcp().callMcpTool(id, 'add', { a: 1, b: 2 }))).toMatch(/not found/)
  })

  it('refuses URLs the SDK would not reach, and keeps nothing', async () => {
    const before = (await registry().listMcpServers()).length
    expect(await failure(registry().connectMcpServer({ name: 'Internal', url: 'https://10.0.0.1/mcp' }))).toMatch(/private\/internal/)
    expect(await registry().listMcpServers()).toHaveLength(before)
  })
})

describe('cleanMcpServerInput', () => {
  const existing = [{ name: 'Cloudflare' }] as McpServerSummary[]

  it('trims the name and normalizes the URL and headers', () => {
    expect(cleanMcpServerInput({ name: '  Docs ', url: 'https://docs.mcp.cloudflare.com/mcp', headers: { ' Authorization ': ' Bearer x ', '': 'ignored' } }, existing))
      .toEqual({ name: 'Docs', url: 'https://docs.mcp.cloudflare.com/mcp', headers: { Authorization: 'Bearer x' } })
    expect(cleanMcpServerInput({ name: 'Local', url: 'http://localhost:8787/mcp' }, existing)).toEqual({ name: 'Local', url: 'http://localhost:8787/mcp' })
  })

  it('refuses a duplicate or missing name', () => {
    expect(() => cleanMcpServerInput({ name: 'cloudflare', url: 'https://example.com/mcp' }, existing)).toThrow('There is already a server named "Cloudflare".')
    expect(() => cleanMcpServerInput({ name: ' ', url: 'https://example.com/mcp' }, existing)).toThrow(/name/)
  })

  it('refuses plain http and malformed URLs', () => {
    expect(() => cleanMcpServerInput({ name: 'A', url: 'http://example.com/mcp' }, existing)).toThrow(/https/)
    expect(() => cleanMcpServerInput({ name: 'A', url: 'not a url' }, existing)).toThrow(/URL/)
  })
})
