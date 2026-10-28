import type { InternalHost } from 'agents/browser'
import { z } from 'zod'
import { errorMessage } from '~/lib/error-message'

/** The internal hostname Pi's browser opens its own dev servers on. */
export const PREVIEW_HOST = 'preview.internal'

/** computerd's port in the container (`PORT` in container/Dockerfile). Its API is never a preview. */
const COMPUTERD_PORT = 8080

/**
 * The port the model points `preview.internal` at. It chooses it, so the
 * schema keeps it to unprivileged ports and away from computerd's own.
 */
export const PreviewTarget = z.object({
  port: z.number().int().min(1024).max(65535).refine((port) => port !== COMPUTERD_PORT, {
    message: `Port ${COMPUTERD_PORT} is computerd's, not a dev server's.`,
  }),
})

/** The parts of a session's container the preview reaches. */
export type PreviewContainer = Pick<Container, 'running' | 'getTcpPort'>

/**
 * `preview.internal` for a session's browser: a dev server Pi runs in its
 * container, on the port the model assigns. Requests go from the browser
 * through this Durable Object to the container, so nothing is public.
 */
export function previewHost(container: () => PreviewContainer | undefined): InternalHost<typeof PreviewTarget> {
  return {
    description: 'A dev server you run on the container backend. Start it there on 0.0.0.0 and a port from 1024, then assign that port. Hot reload cannot connect, so reload the page after a change. Files you change with the file tools reach the container at its next command, so run one there (touch the file) before you reload.',
    target: PreviewTarget,
    fetch: (request, { port }) => fetchPreview(container(), port, request),
  }
}

/**
 * One browser request to the dev server on `port`. Any http page in the
 * browser can send requests to an internal host, so one that names another
 * origin is refused. The server sees `localhost:<port>`, as it would on a
 * developer's machine: dev servers such as Vite refuse hosts they don't
 * know.
 */
export async function fetchPreview(container: PreviewContainer | undefined, port: number, request: Request): Promise<Response> {
  const origin = request.headers.get('Origin')

  if (origin !== null && origin !== `http://${PREVIEW_HOST}`) {
    return new Response(`Requests to ${PREVIEW_HOST} from ${origin} are refused.`, { status: 403 })
  }

  if (!container?.running) {
    return new Response(`The container is not running. Start the dev server on the container backend, listening on 0.0.0.0:${port}, then reload.`, { status: 503 })
  }

  const url = new URL(request.url)
  url.protocol = 'http:'
  url.host = `localhost:${port}`

  try {
    return await container.getTcpPort(port).fetch(new Request(url, request))
  } catch (cause) {
    return new Response(`Nothing answered on port ${port} in the container (${errorMessage(cause)}). Start the dev server there on 0.0.0.0:${port}, then reload.`, { status: 502 })
  }
}
