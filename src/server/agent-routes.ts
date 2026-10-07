import type { AgentOptions } from 'agents'
import { PI_AGENT_PREFIX } from '~/shared/pi-contract'

/**
 * Sessions are reachable only through the registry, which resolves a
 * catalog entry ID and forwards to the session's Agent from inside its own
 * Durable Object. A direct `/pi-session/{name}` route would let any name
 * start an Agent outside the catalog.
 */
function registryOnly(_request: Request, route: { className: string }): Response | undefined {
  return route.className === 'PiSession' ? new Response('Not found', { status: 404 }) : undefined
}

/** `routeAgentRequest` options for the Worker's `/api/agents/*` routes. */
export const AGENT_ROUTES: AgentOptions<Env> = {
  prefix: PI_AGENT_PREFIX,
  onBeforeConnect: registryOnly,
  onBeforeRequest: registryOnly,
}
