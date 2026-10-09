import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { AGENT_ROUTES } from './server/agent-routes'
import { GITHUB_WEBHOOK_PATH, handleGitHubWebhook } from './server/github-webhook'

export { PiSession } from './server/pi-session'
export { PiRegistry } from './server/pi-registry'
// Computer reaches back into PiSession through these entrypoints: the
// container's egress and the Worker Shell's workspace binding.
export { WorkspaceProxy, WorkspaceServiceProxy } from '@cloudflare/computer'

export default createServerEntry({
  async fetch(request) {
    if (new URL(request.url).pathname === GITHUB_WEBHOOK_PATH) return handleGitHubWebhook(request, env)
    const agentResponse = await routeAgentRequest(request, env, AGENT_ROUTES)
    return agentResponse ?? handler.fetch(request)
  },
})
