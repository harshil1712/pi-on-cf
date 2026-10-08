import { afterEach, describe, expect, it, vi } from 'vitest'
import { listRepositories } from './github'

type RepoData = { full_name: string; private: boolean; description: string | null; permissions?: { push?: boolean } }

const repo = (full_name: string, push = true): RepoData => ({ full_name, private: false, description: null, permissions: { push } })

/** A GitHub REST response, with an optional `Link` header for the next page. */
function page(body: unknown, link?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/vnd.github+json', ...(link ? { link } : {}) },
  })
}

describe('listRepositories', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the first page when GitHub sends no Link header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([repo('a/b'), repo('c/d')]))
    vi.stubGlobal('fetch', fetchMock)

    expect(await listRepositories('token')).toEqual([
      { repo: 'a/b', private: false },
      { repo: 'c/d', private: false },
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member')
  })

  it('follows the Link header through every page', async () => {
    const link = (next: string) => `<${next}>; rel="next"`
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([repo('a/b')], link('https://api.github.com/user/repos?per_page=100&page=2')))
      .mockResolvedValueOnce(page([repo('c/d')], link('https://api.github.com/user/repos?per_page=100&page=3')))
      .mockResolvedValueOnce(page([repo('e/f')]))
    vi.stubGlobal('fetch', fetchMock)

    expect((await listRepositories('token')).map((r) => r.repo)).toEqual(['a/b', 'c/d', 'e/f'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // The advertised next URL is followed verbatim, so query params like
    // `per_page` and `sort` survive across pages.
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/user/repos?per_page=100&page=2')
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.github.com/user/repos?per_page=100&page=3')
  })

  it('ignores the `rel="last"` entry and keeps going until `rel="next"` is gone', async () => {
    const link = '<https://api.github.com/user/repos?per_page=100&page=3>; rel="last", <https://api.github.com/user/repos?per_page=100&page=2>; rel="next"'
    const fetchMock = vi.fn().mockResolvedValueOnce(page([repo('a/b')], link)).mockResolvedValueOnce(page([repo('c/d')]))
    vi.stubGlobal('fetch', fetchMock)

    expect((await listRepositories('token')).map((r) => r.repo)).toEqual(['a/b', 'c/d'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/user/repos?per_page=100&page=2')
  })

  it('drops repositories the token cannot push to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([repo('a/b', false), repo('c/d', true)]))
    vi.stubGlobal('fetch', fetchMock)

    expect((await listRepositories('token')).map((r) => r.repo)).toEqual(['c/d'])
  })

  it('forwards the description when GitHub provides one', async () => {
    const withDescription: RepoData = { full_name: 'a/b', private: true, description: 'hello', permissions: { push: true } }
    const fetchMock = vi.fn().mockResolvedValue(page([withDescription]))
    vi.stubGlobal('fetch', fetchMock)

    expect(await listRepositories('token')).toEqual([{ repo: 'a/b', private: true, description: 'hello' }])
  })

  it("throws with GitHub's message on a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listRepositories('token')).rejects.toThrow('GitHub 401: Bad credentials')
  })
})
