import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'
import { routeAgentRequest } from 'agents'
import { PI_AGENT_PREFIX } from './shared/pi-contract'

export { PiSession } from './server/pi-session'
export { PiRegistry } from './server/pi-registry'
export { WorkspaceServiceProxy } from '@cloudflare/computer'

export default createServerEntry({
  async fetch(request) {
    const preview = previewRequest(request)
    if (preview) {
      const stub = env.PiSession.getByName(preview.sessionId) as unknown as { preview(request: Request): Promise<Response> }
      return rewritePreviewResponse(await stub.preview(preview.request), preview.sessionId)
    }
    const agentResponse = await routeAgentRequest(request, env, { prefix: PI_AGENT_PREFIX })
    return agentResponse ?? handler.fetch(request)
  },
})

function previewRequest(request: Request): { sessionId: string; request: Request } | undefined {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/__preview\/([0-9a-f-]{36})(\/.*)?$/i)
  if (!match) return
  const sessionId = match[1]
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return
  url.pathname = match[2] || '/'
  return { sessionId, request: new Request(url, request) }
}

async function rewritePreviewResponse(response: Response, sessionId: string): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? ''
  const prefix = `/__preview/${sessionId}`
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location?.startsWith('/')) {
      const headers = new Headers(response.headers)
      headers.set('location', `${prefix}${location}`)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }
  }
  if (!contentType.includes('text/html') && !contentType.includes('javascript')) return response
  let body = await response.text()
  if (contentType.includes('text/html')) {
    body = body.replaceAll('href="/', `href="${prefix}/`).replaceAll('src="/', `src="${prefix}/`)
  } else {
    body = body.replaceAll('"/api/', `"${prefix}/api/`).replaceAll("'/api/", `'${prefix}/api/`)
  }
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('etag')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
