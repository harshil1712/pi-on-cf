import { describe, expect, it } from 'vitest'
import { fetchPreview, PREVIEW_HOST, previewHost, PreviewTarget, type PreviewContainer } from '~/server/preview-host'

/** A container that answers every port with what it was asked, or fails like an empty port. */
function container({ running = true, refuse = false } = {}) {
  const seen: { port: number; url: string; method: string; host: string | null }[] = []

  const fake: PreviewContainer = {
    running,
    getTcpPort: (port) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        seen.push({ port, url: request.url, method: request.method, host: new URL(request.url).host })

        if (refuse) throw new Error('connection refused')

        return new Response(`served ${new URL(request.url).pathname}`)
      },
      connect: () => { throw new Error('not in tests') },
    }),
  }

  return { fake, seen }
}

const page = (path = '/', init?: RequestInit) => new Request(`http://${PREVIEW_HOST}${path}`, init)

describe('preview.internal', () => {
  it('takes unprivileged ports, and never computerd\'s', () => {
    expect(PreviewTarget.safeParse({ port: 5173 }).success).toBe(true)
    expect(PreviewTarget.safeParse({ port: 8787 }).success).toBe(true)
    expect(PreviewTarget.safeParse({ port: 80 }).success).toBe(false)
    expect(PreviewTarget.safeParse({ port: 8080 }).success).toBe(false)
    expect(PreviewTarget.safeParse({ port: 70000 }).success).toBe(false)
    expect(PreviewTarget.safeParse({ port: 5173.5 }).success).toBe(false)
  })

  it('sends a page request to the port in the container, as localhost', async () => {
    const { fake, seen } = container()
    const response = await fetchPreview(fake, 5173, page('/src/main.ts?v=1'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('served /src/main.ts')
    expect(seen).toEqual([{ port: 5173, url: 'http://localhost:5173/src/main.ts?v=1', method: 'GET', host: 'localhost:5173' }])
  })

  it('serves requests from its own pages', async () => {
    const { fake, seen } = container()
    const response = await fetchPreview(fake, 5173, page('/api/save', { method: 'POST', headers: { Origin: `http://${PREVIEW_HOST}` }, body: '{}' }))

    expect(response.status).toBe(200)
    expect(seen[0]?.method).toBe('POST')
  })

  it('refuses requests from other origins', async () => {
    const { fake, seen } = container()
    const response = await fetchPreview(fake, 5173, page('/api/save', { method: 'POST', headers: { Origin: 'http://example.com' }, body: '{}' }))

    expect(response.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('says to start the dev server when the container is not running', async () => {
    const response = await fetchPreview(container({ running: false }).fake, 5173, page())

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('0.0.0.0:5173')
    expect((await fetchPreview(undefined, 5173, page())).status).toBe(503)
  })

  it('says nothing answered when no server listens on the port', async () => {
    const response = await fetchPreview(container({ refuse: true }).fake, 3000, page())

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('Nothing answered on port 3000')
  })

  it('serves the host from the session\'s current container', async () => {
    let current: PreviewContainer | undefined
    const host = previewHost(() => current)

    expect((await host.fetch(page(), { port: 5173 })).status).toBe(503)

    current = container().fake
    expect((await host.fetch(page('/'), { port: 5173 })).status).toBe(200)
  })
})
