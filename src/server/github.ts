import type { components } from '@octokit/openapi-types'
import type { PullRequest, Repository } from '~/contract'

type Schema = components['schemas']

/** A GitHub repository, `owner/name`. */
export type RepoRef = { owner: string; name: string }

/** A GitHub issue or pull request, by its repository as owner/name and its number. */
export type GitHubThread = { repo: string; number: number }

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
    throw Object.assign(new Error(`GitHub ${response.status}: ${error?.message ?? response.statusText}${detail ? ` (${detail})` : ''}`), { status: response.status })
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

/**
 * Every item of a paginated GET, following `Link` headers for at most
 * `maxPages` pages. `items` picks them out of each page's body, for the
 * endpoints that wrap their list in an object.
 */
async function githubAll<T, Page = T[]>(token: string, path: string, maxPages: number, items: (page: Page) => T[] = (page) => page as T[]): Promise<T[]> {
  const all: T[] = []
  let url: string | null = `${API}${path}`
  for (let page = 0; url && page < maxPages; page++) {
    const { data, next }: { data: Page; next: string | null } = await request<Page>(token, url)
    all.push(...items(data))
    url = next
  }
  return all
}

/**
 * The repository's default branch. Pushing is not checked here: a clone may
 * only be read, and `create_pull_request` reports a push GitHub refuses.
 */
export async function defaultBranch(token: string, repo: RepoRef): Promise<string> {
  return (await github<Schema['full-repository']>(token, `/repos/${repoSlug(repo)}`)).default_branch
}

export type Installation = Schema['installation']

/** The login of the account an installation belongs to; an enterprise's slug. */
export const installationOwner = ({ account }: Installation) => (account && ('login' in account ? account.login : account.slug)) ?? ''

/** The installation of the GitHub App on `repo`, or null where it is not installed. Takes the App's JWT. */
export async function repoInstallation(jwt: string, repo: RepoRef): Promise<Installation | null> {
  return github<Installation>(jwt, `/repos/${repoSlug(repo)}/installation`).catch((error: unknown) => {
    if ((error as { status?: number }).status === 404) return null
    throw error
  })
}

/** Every installation of the GitHub App. Takes the App's JWT. */
export function appInstallations(jwt: string): Promise<Installation[]> {
  return githubAll<Installation>(jwt, '/app/installations?per_page=100', 10)
}

/** Pages of 100 repositories fetched for suggestions; more than this is not worth the wait. */
const REPOSITORY_PAGES = 5

/** The repositories an installation token can reach, up to 500. */
export async function installationRepositories(token: string): Promise<(Repository & { pushedAt: string })[]> {
  const data = await githubAll<Schema['repository'], { repositories: Schema['repository'][] }>(
    token,
    '/installation/repositories?per_page=100',
    REPOSITORY_PAGES,
    (page) => page.repositories,
  )
  return data.map((repo) => ({
    repo: repo.full_name,
    private: repo.private,
    ...(repo.description ? { description: repo.description } : {}),
    pushedAt: repo.pushed_at ?? '',
  }))
}

/** Post a comment on an issue or pull request; returns its URL. */
export async function commentOnIssue(token: string, repo: RepoRef, number: number, body: string): Promise<string> {
  return (await github<Schema['issue-comment']>(token, `/repos/${repoSlug(repo)}/issues/${number}/comments`, { method: 'POST', body: { body } })).html_url
}

/** React to an issue comment, or to a review comment on a pull request's diff. */
export async function reactToComment(token: string, repo: RepoRef, comment: { id: number; review?: object }, content: 'eyes' | 'confused'): Promise<void> {
  const path = comment.review ? 'pulls/comments' : 'issues/comments'
  await github(token, `/repos/${repoSlug(repo)}/${path}/${comment.id}/reactions`, { method: 'POST', body: { content } })
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
