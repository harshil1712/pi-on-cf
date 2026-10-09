import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { botIdentity, type GitHubAppConfig, listRepositories, repoToken } from '~/server/github-app'

let privateKey: string
let publicKey: CryptoKey

/** A fresh RSA key, as the PKCS#8 PEM the README tells you to convert GitHub's key to. */
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)
  const base64 = btoa(String.fromCharCode(...der)).replace(/.{64}/g, '$&\n')
  privateKey = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`
  publicKey = pair.publicKey
})

afterEach(() => vi.restoreAllMocks())

/** A fresh App ID per test, so no test reuses another's cached tokens. */
let appId = 1000
const config = (overrides: Partial<GitHubAppConfig> = {}): GitHubAppConfig => ({
  GITHUB_APP_ID: String(++appId),
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_OWNERS: 'octo, Org',
  ...overrides,
})

const base64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** The App's JWT is RS256 with our key, issued by the App. */
async function checkJwt(authorization: string | null, app: string) {
  const [header, payload, signature] = (authorization ?? '').replace(/^bearer /i, '').split('.')
  expect(JSON.parse(new TextDecoder().decode(base64url(header!)))).toMatchObject({ alg: 'RS256' })
  expect(JSON.parse(new TextDecoder().decode(base64url(payload!)))).toMatchObject({ iss: app })
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, base64url(signature!), new TextEncoder().encode(`${header}.${payload}`))
  expect(valid).toBe(true)
}

type Route = (request: Request) => unknown

/** Serves `routes`, by method and path, as JSON; anything else is a 404. */
function serve(routes: Record<string, Route>) {
  const calls: ReturnType<Request['clone']>[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    // GitHub clients here call fetch with a URL and init.
    const request = new Request(input instanceof Request ? input.url : String(input), init)
    calls.push(request.clone())
    const url = new URL(request.url)
    const route = routes[`${request.method} ${url.pathname}`]
    if (!route) return Response.json({ message: 'Not Found' }, { status: 404 })
    return Response.json(await route(request))
  })
  return calls
}

const accessToken = (token: string) => async (request: Request) => {
  const text = await request.text()
  const body = (text ? JSON.parse(text) : {}) as { repositories?: string[] }
  return {
    token,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { contents: 'write' },
    repository_selection: 'selected',
    ...(body.repositories ? { repositories: body.repositories.map((name) => ({ id: 1, name })) } : {}),
  }
}

describe('repoToken', () => {
  it('finds the repository\'s installation and returns a token scoped to it, cached', async () => {
    const app = config()
    const calls = serve({
      'GET /repos/octo/demo/installation': () => ({ id: 7, account: { login: 'Octo' } }),
      'POST /app/installations/7/access_tokens': accessToken('ghs_demo'),
    })
    expect(await repoToken(app, { owner: 'octo', name: 'demo' })).toBe('ghs_demo')
    await checkJwt(calls[0]!.headers.get('Authorization'), app.GITHUB_APP_ID)
    await checkJwt(calls[1]!.headers.get('Authorization'), app.GITHUB_APP_ID)
    expect(await calls[1]!.json()).toEqual({ repositories: ['demo'] })

    // A second call looks up the installation again, but reuses the token.
    expect(await repoToken(app, { owner: 'octo', name: 'demo' })).toBe('ghs_demo')
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /repos/octo/demo/installation',
      'POST /app/installations/7/access_tokens',
      'GET /repos/octo/demo/installation',
    ])
  })

  it('refuses a repository the App is not installed on', async () => {
    serve({})
    await expect(repoToken(config(), { owner: 'octo', name: 'demo' })).rejects.toThrow('The GitHub App is not installed on octo/demo.')
  })

  it('refuses an installation on an account outside GITHUB_OWNERS', async () => {
    const calls = serve({ 'GET /repos/stranger/demo/installation': () => ({ id: 9, account: { login: 'stranger' } }) })
    await expect(repoToken(config(), { owner: 'stranger', name: 'demo' })).rejects.toThrow('The GitHub App is not installed on stranger/demo.')
    expect(calls).toHaveLength(1)
  })

  it('needs the App configured', async () => {
    await expect(repoToken(config({ GITHUB_APP_PRIVATE_KEY: '' }), { owner: 'octo', name: 'demo' })).rejects.toThrow(/Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_OWNERS/)
    await expect(repoToken(config({ GITHUB_OWNERS: '' }), { owner: 'octo', name: 'demo' })).rejects.toThrow(/GITHUB_OWNERS/)
  })
})

describe('listRepositories', () => {
  it('lists the repositories of owned installations, most recently pushed first', async () => {
    const repo = (name: string, pushed: string) => ({ full_name: name, private: false, description: null, pushed_at: pushed })
    const calls = serve({
      'GET /app/installations': () => [
        { id: 1, account: { login: 'octo' } },
        { id: 2, account: { login: 'org' } },
        { id: 3, account: { login: 'stranger' } },
      ],
      'POST /app/installations/1/access_tokens': accessToken('ghs_1'),
      'POST /app/installations/2/access_tokens': accessToken('ghs_2'),
      'GET /installation/repositories': (request) => ({
        repositories: request.headers.get('Authorization') === 'Bearer ghs_1'
          ? [repo('octo/old', '2026-01-01T00:00:00Z')]
          : [repo('org/new', '2026-03-01T00:00:00Z'), repo('org/mid', '2026-02-01T00:00:00Z')],
      }),
    })
    expect((await listRepositories(config())).map(({ repo }) => repo)).toEqual(['org/new', 'org/mid', 'octo/old'])
    expect(calls.some((call) => new URL(call.url).pathname === '/app/installations/3/access_tokens')).toBe(false)
  })
})

describe('botIdentity', () => {
  it('commits as the App\'s bot user', () => {
    expect(botIdentity({ GITHUB_APP_SLUG: 'pi-on-cf', GITHUB_APP_BOT_ID: '42' })).toEqual({
      name: 'pi-on-cf[bot]',
      email: '42+pi-on-cf[bot]@users.noreply.github.com',
    })
  })
})
