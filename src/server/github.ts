import type { PullRequest, Repository } from '~/shared/pi-contract'

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

/** One GitHub REST API call. Throws GitHub's own message on failure. */
async function github<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
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
  const data = await response.json().catch(() => null) as { message?: string; errors?: { message?: string }[] } | null
  if (!response.ok) {
    const detail = data?.errors?.map((error) => error.message).filter(Boolean).join('; ')
    throw new Error(`GitHub ${response.status}: ${data?.message ?? response.statusText}${detail ? ` (${detail})` : ''}`)
  }
  return data as T
}

/**
 * The repository's default branch. Pushing is not checked here: a clone may
 * only be read, and `create_pull_request` reports a push GitHub refuses.
 */
export async function defaultBranch(token: string, repo: RepoRef): Promise<string> {
  return (await github<{ default_branch: string }>(token, `/repos/${repoSlug(repo)}`)).default_branch
}

type RepoData = { full_name: string; private: boolean; description: string | null; permissions?: { push?: boolean } }

/** The `rel="next"` URL in a GitHub Link header, if any. */
function nextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

/** Repositories the token can push to, most recently pushed first. */
export async function listRepositories(token: string): Promise<Repository[]> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'pi-on-cf',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  // GitHub caps `per_page` at 100, so anything beyond it lives on later pages
  // it advertises through the Link header. Follow them until it runs out.
  let url: string | null = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'
  const repos: RepoData[] = []
  while (url) {
    const response = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, { headers })
    const data = await response.json().catch(() => null) as RepoData[] | { message?: string } | null
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${data && !Array.isArray(data) ? (data.message ?? response.statusText) : response.statusText}`)
    repos.push(...(data as RepoData[]))
    url = nextLink(response.headers.get('link'))
  }
  return repos
    .filter((repo) => repo.permissions?.push !== false)
    .map((repo) => ({ repo: repo.full_name, private: repo.private, ...(repo.description ? { description: repo.description } : {}) }))
}

type PullRequestData = { number: number; html_url: string }
const pullRequest = (data: PullRequestData): PullRequest => ({ number: data.number, url: data.html_url })

/**
 * Open a draft pull request from `branch` into `base`, or update the open
 * one `branch` already has. Looking it up first makes a retry safe.
 */
export async function upsertPullRequest(token: string, repo: RepoRef, input: { branch: string; base: string; title: string; body: string }): Promise<PullRequest & { created: boolean }> {
  const head = encodeURIComponent(`${repo.owner}:${input.branch}`)
  const [open] = await github<PullRequestData[]>(token, `/repos/${repoSlug(repo)}/pulls?state=open&head=${head}`)
  if (open) {
    const updated = await github<PullRequestData>(token, `/repos/${repoSlug(repo)}/pulls/${open.number}`, {
      method: 'PATCH',
      body: { title: input.title, body: input.body },
    })
    return { ...pullRequest(updated), created: false }
  }
  const created = await github<PullRequestData>(token, `/repos/${repoSlug(repo)}/pulls`, {
    method: 'POST',
    body: { title: input.title, body: input.body, head: input.branch, base: input.base, draft: true },
  })
  return { ...pullRequest(created), created: true }
}
