import type { MCPClientManager } from 'agents/mcp/client'
import type { ConnectMcpServerInput, McpServerState, McpServerSummary } from '~/contract'

import type { Json, JsonObject } from '~/lib/json'

export type { Json, JsonObject }

/** A tool as the SDK lists it for a connection. */
type Tool = MCPClientManager['mcpConnections'][string]['tools'][number]

/** One tool of a server, as sessions get it: what the model needs to call it. */
export type McpToolSpec = {
  name: string
  description?: string
  inputSchema: JsonObject
  outputSchema?: JsonObject
}

/** An enabled, connected server and its tools. */
export type McpServerCatalog = {
  id: string
  name: string
  instructions?: string
  tools: McpToolSpec[]
}

/** An MCP tool result, as the server sent it. */
export type McpCallResult = {
  content: ({ type: string } & JsonObject)[]
  structuredContent?: Json
  isError?: boolean
}

const MAX_NAME_LENGTH = 60

/** How long to wait for servers to reconnect, as after the registry wakes. */
const RECONNECT_TIMEOUT_MS = 10_000

/**
 * The registry's MCP servers, on the Agents SDK's `MCPClientManager`, which
 * keeps each server's URL, headers and OAuth tokens in the registry's SQLite
 * and reconnects after a wake. This adds the one setting the SDK lacks:
 * which servers are turned off for sessions.
 */
export class McpServers {
  readonly #mcp: MCPClientManager
  readonly #sql: SqlStorage

  constructor(mcp: MCPClientManager, sql: SqlStorage) {
    this.#mcp = mcp
    this.#sql = sql
    sql.exec('CREATE TABLE IF NOT EXISTS pi_mcp_disabled (id TEXT PRIMARY KEY)')
  }

  list(): McpServerSummary[] {
    const disabled = this.#disabled()

    return this.#mcp.listServers().map((row) => {
      const connection = this.#mcp.mcpConnections[row.id]
      const state: McpServerState = connection?.connectionState ?? (row.auth_url ? 'authenticating' : 'not-connected')

      return {
        id: row.id,
        name: row.name,
        url: row.server_url,
        state,
        ...(connection?.connectionError ? { error: connection.connectionError } : {}),
        ...(state === 'authenticating' && row.auth_url ? { authUrl: row.auth_url } : {}),
        toolCount: connection?.tools.length ?? 0,
        enabled: !disabled.has(row.id),
      }
    // The SDK's list has no order.
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): McpServerSummary {
    const server = this.list().find((entry) => entry.id === id)

    if (!server) throw new Error(`MCP server not found: ${id}`)

    return server
  }

  setEnabled(id: string, enabled: boolean): McpServerSummary {
    this.get(id)
    this.#sql.exec(enabled ? 'DELETE FROM pi_mcp_disabled WHERE id = ?' : 'INSERT OR IGNORE INTO pi_mcp_disabled (id) VALUES (?)', id)

    return this.get(id)
  }

  /** Forget a removed server's setting. */
  forget(id: string): void {
    this.#sql.exec('DELETE FROM pi_mcp_disabled WHERE id = ?', id)
  }

  /** The enabled, connected servers and their tools, once reconnecting servers have settled. */
  async tools(): Promise<McpServerCatalog[]> {
    await this.#mcp.waitForConnections({ timeout: RECONNECT_TIMEOUT_MS })

    return this.list().filter((server) => server.enabled && server.state === 'ready').map((server) => {
      const connection = this.#mcp.mcpConnections[server.id]!

      return {
        id: server.id,
        name: server.name,
        ...(connection.instructions ? { instructions: connection.instructions } : {}),
        tools: connection.tools.map(toolSpec),
      }
    })
  }

  /** Call a tool on an enabled server, reconnecting it once if its connection failed. */
  async call(id: string, name: string, args: JsonObject): Promise<McpCallResult> {
    const server = this.get(id)

    if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`)
    const started = Date.now()

    if (server.state !== 'ready') await this.#mcp.waitForConnections({ timeout: RECONNECT_TIMEOUT_MS })

    if (this.#mcp.mcpConnections[id]?.connectionState === 'failed') await this.connect(id)
    const state = this.#mcp.mcpConnections[id]?.connectionState

    if (state !== 'ready') throw new Error(`MCP server "${server.name}" is not connected${state === 'authenticating' ? ': authorize it in Settings.' : '.'}`)
    const ready = Date.now()
    // SAFETY: the MCP client checked this result against the protocol's CallToolResult schema, and it arrived as JSON-RPC, so its values are JSON.
    const result = await this.#mcp.callTool({ serverId: id, name, arguments: args }) as McpCallResult
    console.log(JSON.stringify({ event: 'mcp.call', server: server.name, tool: name, waitMs: ready - started, callMs: Date.now() - ready, ok: !result.isError }))

    return { content: result.content ?? [], ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }), ...(result.isError ? { isError: true } : {}) }
  }

  /** Connect a registered server and discover its tools; an `authUrl` when it waits for OAuth. */
  async connect(id: string): Promise<{ authUrl?: string }> {
    const result = await this.#mcp.connectToServer(id)

    if (result.state === 'authenticating') return { authUrl: result.authUrl }

    if (result.state === 'failed') throw new Error(result.error)
    const discovered = await this.#mcp.discoverIfConnected(id)

    if (discovered && !discovered.success) throw new Error(discovered.error ?? 'Could not discover the server\'s tools.')

    return {}
  }

  #disabled(): Set<string> {
    return new Set(this.#sql.exec<{ id: string }>('SELECT id FROM pi_mcp_disabled').toArray().map((row) => row.id))
  }
}

/**
 * Check what the Settings page sends before connecting: a unique name, and
 * an https URL (or http on localhost, for development). The SDK refuses
 * private and metadata addresses, and `fetch` refuses malformed headers.
 */
export function cleanMcpServerInput(input: ConnectMcpServerInput, existing: McpServerSummary[]): ConnectMcpServerInput {
  const name = input.name?.trim()

  if (!name) throw new Error('Give the server a name.')

  if (name.length > MAX_NAME_LENGTH) throw new Error(`Server names are limited to ${MAX_NAME_LENGTH} characters.`)
  const taken = existing.find((server) => server.name.toLowerCase() === name.toLowerCase())

  if (taken) throw new Error(`There is already a server named "${taken.name}".`)
  let url: URL

  try {
    url = new URL(input.url?.trim() ?? '')
  } catch {
    throw new Error('Enter the server\'s full URL, starting with https://.')
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('MCP server URLs must use https.')
  const headers = Object.entries(input.headers ?? {}).map(([key, value]) => [key.trim(), value.trim()]).filter(([key]) => key)

  return { name, url: url.href, ...(headers.length ? { headers: Object.fromEntries(headers) } : {}) }
}

/** A tool as sessions get it. */
function toolSpec(tool: Tool): McpToolSpec {
  // SAFETY: the MCP client checked the server's tools/list response against the protocol's schema, and it arrived as JSON.
  const spec: McpToolSpec = { name: tool.name, inputSchema: tool.inputSchema as JsonObject }

  if (tool.description) spec.description = tool.description

  if (tool.outputSchema) {
    // SAFETY: like inputSchema, the output schema arrived as JSON.
    spec.outputSchema = tool.outputSchema as JsonObject
  }

  return spec
}
