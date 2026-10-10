import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * An MCP server for the registry's tests, reached over the Agents SDK's RPC
 * transport, so tests need neither the network nor OAuth.
 */
export class TestMcp extends McpAgent<Env> {
  server = new McpServer({ name: 'TestMcp', version: '1.0.0' }, { instructions: 'Arithmetic for tests.' })

  async init() {
    this.server.registerTool(
      'add',
      { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
    )
    this.server.registerTool(
      'fail',
      { description: 'Always fails' },
      async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }),
    )
  }
}
