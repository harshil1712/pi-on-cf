import { afterEach, describe, expect, it, vi } from 'vitest'
import { listRepositories, nextPage } from '~/server/github'

const API = 'https://api.github.com'

describe('nextPage', () => {
  it('finds the rel="next" URL among other links', () => {
    const link = `<${API}/user/repos?page=1>; rel="prev", <${API}/user/repos?page=3>; rel="next", <${API}/user/repos?page=9>; rel="last"`
    expect(nextPage(link)).toBe(`${API}/user/repos?page=3`)
  })

  it('is null on the last page or without a header', () => {
    expect(nextPage(`<${API}/user/repos?page=1>; rel="first"`)).toBeNull()
    expect(nextPage(null)).toBeNull()
  })

  it('refuses a URL off api.github.com, so the token stays there', () => {
    expect(nextPage('<https://evil.example/user/repos?page=2>; rel="next"')).toBeNull()
    expect(nextPage('<https://api.github.com.evil.example/x>; rel="next"')).toBeNull()
  })
})

describe('listRepositories', () => {
  afterEach(() => vi.restoreAllMocks())

  const repo = (n: number, push = true) => ({ full_name: `octo/r${n}`, private: false, description: null, permissions: { push } })

  /** Serves `pages` in order, linking each to the next. */
  function serve(pages: unknown[][]) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const page = Number(new URL(input instanceof Request ? input.url : input).searchParams.get('page') ?? '1')
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (page < pages.length) headers.set('Link', `<${API}/user/repos?per_page=100&page=${page + 1}>; rel="next"`)
      return new Response(JSON.stringify(pages[page - 1]), { headers })
    })
  }

  it('follows Link headers across pages and drops read-only repositories', async () => {
    const fetch = serve([[repo(1), repo(2, false)], [repo(3)]])
    const repos = await listRepositories('t')
    expect(repos.map((r) => r.repo)).toEqual(['octo/r1', 'octo/r3'])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get('Authorization')).toBe('Bearer t')
  })

  it('stops after five pages', async () => {
    const fetch = serve(Array.from({ length: 8 }, (_, i) => [repo(i)]))
    expect(await listRepositories('t')).toHaveLength(5)
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})
