import { afterEach, describe, expect, it, vi } from 'vitest'
import { commentOnIssue, createIssue, installationRepositories, nextPage, reactToComment, readIssue } from '~/server/github'
import { renderIssue } from '~/server/task'

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

describe('comments and reactions', () => {
  afterEach(() => vi.restoreAllMocks())

  function record() {
    const calls: { method: string; url: string; body: unknown }[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ method: init?.method ?? 'GET', url: input instanceof Request ? input.url : input.toString(), body: JSON.parse(init?.body as string) })
      return Response.json({ html_url: 'https://github.com/octo/demo/issues/5#issuecomment-1' }, { status: 201 })
    })
    return calls
  }

  it('comments on an issue or pull request through the issues API', async () => {
    const calls = record()
    expect(await commentOnIssue('t', { owner: 'octo', name: 'demo' }, 5, 'Done.')).toBe('https://github.com/octo/demo/issues/5#issuecomment-1')
    expect(calls).toEqual([{ method: 'POST', url: `${API}/repos/octo/demo/issues/5/comments`, body: { body: 'Done.' } }])
  })

  it('reacts to issue comments and review comments at their own paths', async () => {
    const calls = record()
    await reactToComment('t', { owner: 'octo', name: 'demo' }, { id: 1 }, 'eyes')
    await reactToComment('t', { owner: 'octo', name: 'demo' }, { id: 2, review: {} }, 'confused')
    expect(calls).toEqual([
      { method: 'POST', url: `${API}/repos/octo/demo/issues/comments/1/reactions`, body: { content: 'eyes' } },
      { method: 'POST', url: `${API}/repos/octo/demo/pulls/comments/2/reactions`, body: { content: 'confused' } },
    ])
  })
})

describe('issues', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens an issue, with labels only when given', async () => {
    const calls: { method: string; url: string; body: unknown }[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ method: init?.method ?? 'GET', url: input instanceof Request ? input.url : input.toString(), body: JSON.parse(init?.body as string) })
      return Response.json({ number: 7, html_url: 'https://github.com/octo/demo/issues/7' }, { status: 201 })
    })
    expect(await createIssue('t', { owner: 'octo', name: 'demo' }, { title: 'Bug', body: 'It breaks.' })).toEqual({ number: 7, url: 'https://github.com/octo/demo/issues/7' })
    await createIssue('t', { owner: 'octo', name: 'demo' }, { title: 'Bug', body: 'x', labels: ['bug'] })
    expect(calls).toEqual([
      { method: 'POST', url: `${API}/repos/octo/demo/issues`, body: { title: 'Bug', body: 'It breaks.' } },
      { method: 'POST', url: `${API}/repos/octo/demo/issues`, body: { title: 'Bug', body: 'x', labels: ['bug'] } },
    ])
  })

  it('reads an issue with its comments, and renders it for the model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/comments')) return Response.json([{ user: { login: 'bob' }, created_at: '2026-01-02T00:00:00Z', body: 'Me too.' }])
      return Response.json({ number: 7, html_url: 'https://github.com/octo/demo/issues/7', title: 'Bug', state: 'open', user: { login: 'alice' }, labels: [{ name: 'bug' }, 'p1'], body: 'It breaks.' })
    })
    const issue = await readIssue('t', { owner: 'octo', name: 'demo' }, 7)
    expect(issue).toEqual({
      number: 7, url: 'https://github.com/octo/demo/issues/7', title: 'Bug', state: 'open', author: 'alice', pullRequest: false,
      labels: ['bug', 'p1'], body: 'It breaks.', comments: [{ author: 'bob', createdAt: '2026-01-02T00:00:00Z', body: 'Me too.' }],
    })
    const text = renderIssue('octo/demo', issue)
    expect(text).toContain('Issue octo/demo#7: Bug')
    expect(text).toContain('Labels: bug, p1.')
    expect(text).toContain('--- @bob commented at 2026-01-02T00:00:00Z:\n\nMe too.')
    expect(renderIssue('octo/demo', { ...issue, body: 'x'.repeat(70_000) })).toMatch(/\[Cut at 60000 characters; see https:\/\/github.com\/octo\/demo\/issues\/7 for the rest.\]$/)
  })
})
