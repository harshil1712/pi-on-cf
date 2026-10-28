import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { AGENT_ROUTES } from './server/agent-routes'
import { GITHUB_WEBHOOK_PATH, handleGitHubWebhook } from './server/github-webhook'
import { GENERIC_WEBHOOK_PATH, handleGenericWebhook } from './server/generic-webhook'

export { PiSession } from './server/pi-session'

export { PiRegistry } from './server/pi-registry'

// Computer reaches back into PiSession through these entrypoints: the
// container's egress and the Worker Shell's workspace binding.
export { WorkspaceProxy, WorkspaceServiceProxy } from '@cloudflare/computer'

// The mcp tool's codemode runtime is a facet of each session.
export { CodemodeRuntime } from '@cloudflare/codemode'

// Browser Run sends a session's browser requests for its internal hosts,
// such as preview.internal, through this entrypoint to the session.
export { InternalHostRouter } from 'agents/browser'

export default createServerEntry({
  async fetch(request) {
    const { pathname } = new URL(request.url)

    if (pathname === GITHUB_WEBHOOK_PATH) return handleGitHubWebhook(request, env)

    if (pathname === GENERIC_WEBHOOK_PATH) return handleGenericWebhook(request, env)
    const agentResponse = await routeAgentRequest(request, env, AGENT_ROUTES)

    return agentResponse ?? handler.fetch(request)
  },
})
