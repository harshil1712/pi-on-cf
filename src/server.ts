import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { PI_AGENT_PREFIX } from './shared/pi-contract'

export { PiSession } from './server/pi-session'
export { PiRegistry } from './server/pi-registry'

export default createServerEntry({
  async fetch(request) {
    const agentResponse = await routeAgentRequest(request, env, { prefix: PI_AGENT_PREFIX })
    return agentResponse ?? handler.fetch(request)
  },
})
