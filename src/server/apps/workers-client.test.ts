import { describe, expect, it, vi } from 'vitest'
import { WorkersClient } from './workers-client'

const envelope = (result: unknown) => new Response(JSON.stringify({ success: true, result }), {
  headers: { 'content-type': 'application/json' },
})

describe('WorkersClient', () => {
  it('uses the Workers asset hash protocol and deploys the created version', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path.endsWith('/workers/workers/example')) return envelope({ id: 'worker-id' })
      if (path.endsWith('/assets-upload-session')) {
        return envelope({ buckets: [], jwt: 'assets-jwt' })
      }
      if (path.endsWith('/workers/workers/worker-id/versions')) return envelope({ id: 'version-id' })
      if (path.endsWith('/workers/scripts/example/deployments')) return envelope({ id: 'deployment-id' })
      if (path.endsWith('/workers/subdomain')) return envelope({ subdomain: 'account' })
      throw new Error(`Unexpected request: ${path}`)
    })

    const result = await new WorkersClient({ accountId: 'account-id', token: 'token', fetch }).deploy({
      name: 'example',
      modules: [{ name: 'index.js', content: 'export default {}', contentType: 'application/javascript+module' }],
      assets: [{ path: '/hello.txt', content: 'hello', contentType: 'text/plain' }],
      config: { mainModule: 'index.js', compatibilityDate: '2026-07-27' },
    })

    const manifestRequest = requests.find((request) => request.url.endsWith('/assets-upload-session'))
    expect(await manifestRequest?.json()).toEqual({
      manifest: { '/hello.txt': { hash: 'f0b3413d4cabb000327fad369003d6a5', size: 5 } },
    })
    expect(result).toEqual({
      workerId: 'worker-id',
      versionId: 'version-id',
      deploymentId: 'deployment-id',
      productionUrl: 'https://example.account.workers.dev',
    })
  })
})
