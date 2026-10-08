import type { AgentEvent } from '@earendil-works/pi-durable'

export const PI_AGENT_NAME = 'PiSession'
export const PI_REGISTRY_NAME = 'PiRegistry'
export const PI_AGENT_PREFIX = 'api/agents'
export const PI_REGISTRY_INSTANCE = 'singleton'
/** The registry's route segment for sessions; see `sessionBasePath`. */
export const PI_SESSIONS_ROUTE = 'sessions'

/**
 * A session's path, through the registry: the registry owns the catalog and
 * forwards the session's requests and WebSocket to its Agent, whose own name
 * never leaves the registry. `pi-registry` is the kebab-case of the
 * `PiRegistry` binding, as `routeAgentRequest` matches it.
 */
export function sessionBasePath(sessionId: string): string {
  return `${PI_AGENT_PREFIX}/pi-registry/${PI_REGISTRY_INSTANCE}/${PI_SESSIONS_ROUTE}/${encodeURIComponent(sessionId)}`
}

/**
 * Server → browser frame on a PiSession connection. It carries pi-durable's
 * own agent events: the first batch of every watch starts with a `snapshot`
 * that replaces the client's state, and each later batch is one commit.
 */
export type PiEventsMessage = {
  type: 'pi:events'
  events: readonly AgentEvent[]
}

export type WorkspaceFile = {
  path: string
  size: number
  mtime: string
}

export type WorkspaceFileContent = WorkspaceFile & {
  content: string
}

export type PullRequest = {
  number: number
  url: string
}

/** A repository the session can work on, for `@` suggestions. */
export type Repository = {
  /** `owner/name` */
  repo: string
  private: boolean
  description?: string
}

/** The GitHub repository a session cloned, when the model called `clone_repository`. */
export type SessionTask = {
  /** `owner/name` */
  repo: string
  /** The branch the task starts from and its pull request targets. */
  baseBranch: string
  /** The commit the task started from; changes are measured against it. */
  baseCommit: string
  /** The branch the agent's work is pushed to. */
  branch: string
  /** Where the clone lives in the workspace. */
  dir: string
  pullRequest?: PullRequest
}

/** A PiSession's Agent state, synced to its clients by the Agents SDK. Only the server writes it. */
export type PiSessionState = {
  task: SessionTask | null
}

/** One file the task changed since its base commit, uncommitted work included. */
export type TaskChange = {
  path: string
  status: 'A' | 'M' | 'D'
  insertions: number
  deletions: number
}

export type SessionSummary = {
  id: string
  name?: string
  repo?: string
  branch?: string
  pullRequest?: PullRequest
  createdAt: string
  updatedAt: string
}

export interface PiSessionContract {
  readonly state: PiSessionState
  submit(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  steer(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  abort(): void
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  listRepositories(): Promise<Repository[]>
  listChanges(): Promise<TaskChange[]>
  readChange(path: string): Promise<string>
}

export interface PiRegistryContract {
  readonly state: unknown
  createSession(input?: { name?: string }): Promise<SessionSummary>
  getSession(sessionId: string): Promise<SessionSummary | null>
  listSessions(): Promise<SessionSummary[]>
  renameSession(sessionId: string, name?: string): Promise<SessionSummary>
  deleteSession(sessionId: string): Promise<void>
}
