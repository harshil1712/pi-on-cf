import { createPiTools, type CreatePiToolsOptions } from '@cloudflare/computer/tools/pi-ai'
import type { ToolRegistration } from '@earendil-works/pi-durable'

/**
 * Tools pi may run again when an eviction interrupted them. Reads and
 * searches have no effect, `write` replaces the whole file, and `delete`
 * succeeds on a missing path. `edit` would not find text it already
 * replaced, and `exec` has outside effects, so pi reports
 * those to the model as interrupted instead of rerunning them.
 */
const REPLAY_SAFE = new Set(['read', 'ls', 'find', 'grep', 'write', 'delete'])

/**
 * Computer's pi tool set as pi-durable tool registrations.
 *
 * `createPiTools` returns pi-ai declarations and one `execute(call)` for a
 * hand-written agent loop. pi-durable runs the loop itself and wants each
 * tool to carry its own `execute`, so this pairs them by name.
 */
export function createWorkspaceTools(options: CreatePiToolsOptions): ToolRegistration[] {
  const { tools, execute } = createPiTools(options)
  return tools.map((tool): ToolRegistration => ({
    name: tool.name,
    description: tool.description,
    // Computer declares plain JSON Schema. pi validates with TypeBox, which
    // accepts it; only the static type differs.
    parameters: tool.parameters as unknown as ToolRegistration['parameters'],
    ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
    replay: REPLAY_SAFE.has(tool.name) ? 'safe' : 'unsafe',
    async execute(args, api, context) {
      const { content, isError } = await execute(
        { id: api.callId, name: tool.name, arguments: args },
        { abortSignal: context.abortSignal },
      )
      return { content, isError }
    },
  }))
}
