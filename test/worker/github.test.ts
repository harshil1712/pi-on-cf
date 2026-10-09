import { afterEach, describe, expect, it, vi } from 'vitest'
import { installationRepositories, nextPage } from '~/server/github'

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

describe('installationRepositories', () => {
  afterEach(() => vi.restoreAllMocks())

  const repo = (n: number) => ({ full_name: `octo/r${n}`, private: n % 2 === 0, description: n === 1 ? 'one' : null, pushed_at: `2026-01-0${n}T00:00:00Z` })

  /** Serves `pages` of `{ repositories }` in order, linking each to the next. */
  function serve(pages: unknown[][]) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const page = Number(new URL(input instanceof Request ? input.url : input).searchParams.get('page') ?? '1')
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (page < pages.length) headers.set('Link', `<${API}/installation/repositories?per_page=100&page=${page + 1}>; rel="next"`)
      return new Response(JSON.stringify({ total_count: pages.flat().length, repositories: pages[page - 1] }), { headers })
    })
  }

  it('follows Link headers across pages', async () => {
    const fetch = serve([[repo(1), repo(2)], [repo(3)]])
    expect(await installationRepositories('t')).toEqual([
      { repo: 'octo/r1', private: false, description: 'one', pushedAt: '2026-01-01T00:00:00Z' },
      { repo: 'octo/r2', private: true, pushedAt: '2026-01-02T00:00:00Z' },
      { repo: 'octo/r3', private: false, pushedAt: '2026-01-03T00:00:00Z' },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get('Authorization')).toBe('Bearer t')
  })

  it('stops after five pages', async () => {
    const fetch = serve(Array.from({ length: 8 }, (_, i) => [repo(i)]))
    expect(await installationRepositories('t')).toHaveLength(5)
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})
