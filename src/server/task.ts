import type { WorkspaceClient } from '@cloudflare/computer'
import type { GitClient } from '@cloudflare/computer/git'
import { Type } from '@earendil-works/pi-ai'
import type { PromptSection, ToolRegistration } from '@earendil-works/pi-durable'
import type { PullRequest, SessionTask, TaskChange } from '~/contract'
import { cloneUrl, defaultBranch, gitAuth, gitAuthHeaders, parseRepo, repoSlug, upsertPullRequest } from './github'
import { WORKSPACE_ROOT } from './workspace-root'

/** Devin's limit for an injected AGENTS.md; longer files are cut, and the agent can read the rest. */
const AGENTS_MD_LIMIT = 16 * 1024

const git = (workspace: WorkspaceClient) => workspace.git as GitClient

/**
 * Clone `repo` into the workspace and start the task's branch from
 * `baseBranch`, the repository's default branch unless given.
 */
export async function cloneTask(workspace: WorkspaceClient, token: string | undefined, input: { repo: string; baseBranch?: string; branch: string }): Promise<SessionTask> {
  if (!token) throw new Error('Set the GITHUB_TOKEN secret to work on GitHub repositories.')
  const repo = parseRepo(input.repo)
  const baseBranch = input.baseBranch?.trim() || await defaultBranch(token, repo)
  const dir = `${WORKSPACE_ROOT}/${repo.name}`
  // The token is passed per call, so the workspace's own git, which the
  // agent runs, has no credentials.
  if (await workspace.fs.stat(dir).then(() => true, () => false)) throw new Error(`${dir} already exists; move it before working on ${repoSlug(repo)}.`)
  try {
    await git(workspace).clone({ url: cloneUrl(repo), dir, ref: baseBranch, depth: 1, headers: gitAuthHeaders(token) })
  } catch (error) {
    // A half-written clone would make the next attempt fail on a non-empty directory.
    await workspace.fs.rm(dir, { recursive: true, force: true })
    throw new Error(`Could not clone ${repoSlug(repo)}#${baseBranch}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const baseCommit = await git(workspace).revParse({ dir, ref: 'HEAD' })
  await git(workspace).branch({ dir, name: input.branch, checkout: true })
  return { repo: repoSlug(repo), baseBranch, baseCommit, branch: input.branch, dir }
}

/** Files the task changed since its base commit, committed or not. */
export async function listChanges(workspace: WorkspaceClient, task: SessionTask): Promise<TaskChange[]> {
  return git(workspace).diffSummary({ dir: task.dir, ref: task.baseCommit })
}

/** The unified diff of one changed file, by its path in the repository. */
export async function readChange(workspace: WorkspaceClient, task: SessionTask, path: string): Promise<string> {
  return git(workspace).diff({ dir: task.dir, ref: task.baseCommit, paths: [path] })
}

/** How to reach GitHub repositories, then the cloned one and its AGENTS.md, before every model request. */
export function taskSection(task: () => SessionTask | null, workspace: () => Promise<WorkspaceClient>): PromptSection {
  return {
    key: 'repository',
    async render() {
      const current = task()
      if (!current) {
        return [
          'The user refers to GitHub repositories as @owner/name, or @owner/name#branch for a branch other than the default.',
          'When you need a repository\'s code, to answer questions about it or to change it, call clone_repository. Do not clone for questions you can answer without the code. A session clones one repository.',
        ].join('\n')
      }
      const lines = [
        `You cloned the GitHub repository ${current.repo} at ${current.dir}.`,
        `You are on the branch ${current.branch}, started from ${current.baseBranch}. Keep any changes on this branch.`,
        'If the user wants changes, commit them with git once they are done and checked, and call create_pull_request. It pushes the branch and opens a draft pull request, or updates the one already open. Pushing with git yourself fails: only create_pull_request has GitHub credentials. Do not open a pull request when the user only asked about the code.',
      ]
      const agents = await (await workspace()).fs.readFile(`${current.dir}/AGENTS.md`, 'utf8').catch(() => '')
      if (agents) {
        const cut = agents.length > AGENTS_MD_LIMIT
        lines.push('', `The repository's AGENTS.md${cut ? `, cut at ${AGENTS_MD_LIMIT} characters; read the file for the rest` : ''}:`, '', cut ? agents.slice(0, AGENTS_MD_LIMIT) : agents)
      }
      return lines.join('\n')
    },
  }
}

type TaskToolsOptions = {
  workspace: WorkspaceClient
  task: () => SessionTask | null
  token: () => string | undefined
  /** Clone the repository and make it the session's task. */
  openRepository: (input: { repo: string; baseBranch?: string }) => Promise<SessionTask>
  onPullRequest: (pullRequest: PullRequest) => Promise<void>
}

/**
 * `clone_repository`, which the model calls when it needs a repository's
 * code, and `create_pull_request`, the only way its work leaves the workspace.
 */
export function createTaskTools({ workspace, task, token, openRepository, onPullRequest }: TaskToolsOptions): ToolRegistration[] {
  const cloneParameters = Type.Object({
    repo: Type.String({ description: 'The repository, as owner/name.' }),
    baseBranch: Type.Optional(Type.String({ description: 'The branch to start from. Defaults to the repository\'s default branch.' })),
  })
  const parameters = Type.Object({
    title: Type.String({ description: 'The pull request title.' }),
    body: Type.String({ description: 'The pull request description in Markdown: what changed, why, and how you checked it.' }),
  })
  return [{
    name: 'clone_repository',
    description: 'Clone a GitHub repository into the workspace, shallow, and check out a new branch for this session\'s work. Use it when you need the code to answer a question or make a change.',
    parameters: cloneParameters as unknown as ToolRegistration['parameters'],
    // Once a clone has made the task, running it again reports that task.
    replay: 'safe',
    async execute(args) {
      const { repo, baseBranch } = args as { repo: string; baseBranch?: string }
      const current = task()
      if (current) {
        const same = current.repo.toLowerCase() === repo.replace(/^@/, '').toLowerCase()
        return same ? success(cloned(current)) : failure(`This session already cloned ${current.repo}, and works on one repository.`)
      }
      try {
        return success(cloned(await openRepository({ repo: repo.replace(/^@/, ''), baseBranch })))
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    },
  }, {
    name: 'create_pull_request',
    description: 'Push this task\'s branch to GitHub and open a draft pull request into its base branch, or update the title and description of the one already open. Commit your work first; uncommitted changes are refused.',
    parameters: parameters as unknown as ToolRegistration['parameters'],
    // Pushing the same commits again changes nothing, and an open pull
    // request is found and updated rather than opened twice.
    replay: 'safe',
    async execute(args) {
      const { title, body } = args as { title: string; body: string }
      const current = task()
      if (!current) return failure('This session has no repository.')
      const secret = token()
      if (!secret) return failure('GITHUB_TOKEN is not set.')
      const dirty = await git(workspace).status({ dir: current.dir })
      if (dirty.length) {
        return failure(`Commit or discard these changes first:\n${dirty.slice(0, 20).map((entry) => `${entry.index}${entry.worktree} ${entry.path}`).join('\n')}`)
      }
      const pushed = await git(workspace).push({
        dir: current.dir,
        remote: 'origin',
        ref: current.branch,
        remoteRef: current.branch,
        onAuth: () => gitAuth(secret),
      }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), refs: {} }))
      if (!pushed.ok) return failure(`Push failed: ${pushed.error ?? JSON.stringify(pushed.refs)}`)
      try {
        const pullRequest = await upsertPullRequest(secret, parseRepo(current.repo), { branch: current.branch, base: current.baseBranch, title, body })
        await onPullRequest({ number: pullRequest.number, url: pullRequest.url })
        return success(`${pullRequest.created ? 'Opened draft' : 'Updated'} pull request #${pullRequest.number}: ${pullRequest.url}`)
      } catch (error) {
        return failure(`Pushed ${current.branch}, but the pull request failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }]
}

function cloned(task: SessionTask): string {
  return `Cloned ${task.repo}#${task.baseBranch} at ${task.dir}, on the branch ${task.branch}.`
}

function success(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function failure(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}
