import type { components } from '@octokit/openapi-types'
import type { PullRequest, Repository } from '~/contract'

type Schema = components['schemas']

/** A GitHub repository, `owner/name`. */
export type RepoRef = { owner: string; name: string }

const NAME = /^[A-Za-z0-9_.-]+$/

/** Accepts `owner/name` or an `https://github.com/owner/name` URL, with or without `.git`. */
export function parseRepo(input: string): RepoRef {
  const path = input.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '')
  const [owner, name, ...rest] = path.split('/')
  if (!owner || !name || rest.length || !NAME.test(owner) || !NAME.test(name)) {
    throw new Error(`"${input}" is not a GitHub repository. Use owner/name.`)
  }
  return { owner, name }
}

export const repoSlug = ({ owner, name }: RepoRef) => `${owner}/${name}`
export const cloneUrl = (repo: RepoRef) => `https://github.com/${repoSlug(repo)}.git`

/** Git over HTTPS takes an access token as the password of any user. */
export const gitAuth = (token: string) => ({ username: 'x-access-token', password: token })
export const gitAuthHeaders = (token: string) => ({ Authorization: `Basic ${btoa(`x-access-token:${token}`)}` })

const API = 'https://api.github.com'

/** One GitHub REST API call, with the URL of the next page if there is one. Throws GitHub's own message on failure. */
async function request<T>(token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<{ data: T; next: string | null }> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'pi-on-cf',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = data as Partial<Schema['validation-error']> | null
    const detail = error?.errors?.map((item) => item.message).filter(Boolean).join('; ')
    throw new Error(`GitHub ${response.status}: ${error?.message ?? response.statusText}${detail ? ` (${detail})` : ''}`)
  }
  return { data: data as T, next: nextPage(response.headers.get('Link')) }
}

/** One GitHub REST API call to `path`. */
const github = async <T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> =>
  (await request<T>(token, `${API}${path}`, init)).data

/**
 * The `rel="next"` URL of a `Link` header. Only an api.github.com URL is
 * followed, so the token is never sent anywhere else.
 */
export function nextPage(link: string | null): string | null {
  const url = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
  return url?.startsWith(`${API}/`) ? url : null
}

/** Every item of a paginated GET, following `Link` headers for at most `maxPages` pages. */
async function githubAll<T>(token: string, path: string, maxPages: number): Promise<T[]> {
  const items: T[] = []
  let url: string | null = `${API}${path}`
  for (let page = 0; url && page < maxPages; page++) {
    const { data, next }: { data: T[]; next: string | null } = await request<T[]>(token, url)
    items.push(...data)
    url = next
  }
  return items
}

/**
 * The repository's default branch. Pushing is not checked here: a clone may
 * only be read, and `create_pull_request` reports a push GitHub refuses.
 */
export async function defaultBranch(token: string, repo: RepoRef): Promise<string> {
  return (await github<Schema['full-repository']>(token, `/repos/${repoSlug(repo)}`)).default_branch
}

/** Pages of 100 repositories fetched for suggestions; more than this is not worth the wait. */
const REPOSITORY_PAGES = 5

/** Repositories the token can push to, most recently pushed first, up to 500. */
export async function listRepositories(token: string): Promise<Repository[]> {
  const data = await githubAll<Schema['repository']>(
    token,
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    REPOSITORY_PAGES,
  )
  return data
    .filter((repo) => repo.permissions?.push !== false)
    .map((repo) => ({ repo: repo.full_name, private: repo.private, ...(repo.description ? { description: repo.description } : {}) }))
}

const pullRequest = (data: Pick<Schema['pull-request'], 'number' | 'html_url'>): PullRequest => ({ number: data.number, url: data.html_url })

/**
 * Open a draft pull request from `branch` into `base`, or update the open
 * one `branch` already has. Looking it up first makes a retry safe.
 */
export async function upsertPullRequest(token: string, repo: RepoRef, input: { branch: string; base: string; title: string; body: string }): Promise<PullRequest & { created: boolean }> {
  const head = encodeURIComponent(`${repo.owner}:${input.branch}`)
  const [open] = await github<Schema['pull-request-simple'][]>(token, `/repos/${repoSlug(repo)}/pulls?state=open&head=${head}`)
  if (open) {
    const updated = await github<Schema['pull-request']>(token, `/repos/${repoSlug(repo)}/pulls/${open.number}`, {
      method: 'PATCH',
      body: { title: input.title, body: input.body },
    })
    return { ...pullRequest(updated), created: false }
  }
  const created = await github<Schema['pull-request']>(token, `/repos/${repoSlug(repo)}/pulls`, {
    method: 'POST',
    body: { title: input.title, body: input.body, head: input.branch, base: input.base, draft: true },
  })
  return { ...pullRequest(created), created: true }
}
