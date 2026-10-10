import type { AgentEvent } from '@earendil-works/pi-durable'
import type { RunStatus } from '~/lib/run-status'

export type { RunStatus }

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
  /** The ID of the model pi answers with, one of `listModels()`. */
  model: string
}

/** A model the session can switch to. */
export type ModelOption = {
  id: string
  label: string
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
  /** From the session's first prompt. */
  title?: string
  repo?: string
  branch?: string
  pullRequest?: PullRequest
  /** What pi is doing, as the session last reported it. A change moves the session to the top. */
  status: RunStatus
  createdAt: string
  updatedAt: string
}

/** One of the tabs in the session's browser, as Live View offers it. */
export type BrowserTabView = {
  /** The tab's CDP target ID, stable while it stays open. */
  targetId: string
  /** The embeddable Live View URL for the tab, a bearer credential that connects for about five minutes. */
  url: string
  /** What the tab is showing now. */
  pageUrl?: string
  title?: string
}

export interface PiSessionContract {
  readonly state: PiSessionState
  submit(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  steer(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  abort(): void
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  listChanges(): Promise<TaskChange[]>
  readChange(path: string): Promise<string>
  listModels(): Promise<ModelOption[]>
  setModel(id: string): Promise<void>
  /** The session's browser tabs to watch live, or null when this deployment has no browser. */
  browserLiveView(): Promise<BrowserTabView[] | null>
}

/**
 * Where an MCP server's connection stands, as the Agents SDK reports it.
 * `not-connected` is a saved server with no connection yet, such as right
 * after the registry wakes.
 */
export type McpServerState = 'ready' | 'authenticating' | 'connecting' | 'connected' | 'discovering' | 'failed' | 'not-connected'

/** One MCP server connected on the registry, for the Settings page. Never carries credentials. */
export type McpServerSummary = {
  id: string
  name: string
  url: string
  state: McpServerState
  error?: string
  /** Where to authorize, while `state` is `authenticating`. */
  authUrl?: string
  /** Tools the connected server offers. */
  toolCount: number
  /** Whether sessions can use the server. */
  enabled: boolean
}

export type ConnectMcpServerInput = {
  name: string
  url: string
  /** Sent with every request, e.g. `Authorization: Bearer <token>`. Without them the server may ask for OAuth. */
  headers?: Record<string, string>
}

/** A server just added or reconnected; `authUrl` when it waits for OAuth in the browser. */
export type ConnectMcpServerResult = {
  server: McpServerSummary
  authUrl?: string
}

/** The registry's Agent state: a revision every catalog change bumps, so pages know to reload the list. */
export type PiRegistryState = {
  revision: number
}

export interface PiRegistryContract {
  readonly state: PiRegistryState
  createSession(input?: { name?: string; prompt?: string; model?: string }): Promise<SessionSummary>
  getSession(sessionId: string): Promise<SessionSummary | null>
  listSessions(): Promise<SessionSummary[]>
  renameSession(sessionId: string, name?: string): Promise<SessionSummary>
  deleteSession(sessionId: string): Promise<void>
  listRepositories(): Promise<Repository[]>
  listModels(): Promise<ModelOption[]>
  listMcpServers(): Promise<McpServerSummary[]>
  connectMcpServer(input: ConnectMcpServerInput): Promise<ConnectMcpServerResult>
  reconnectMcpServer(id: string): Promise<ConnectMcpServerResult>
  setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerSummary>
  deleteMcpServer(id: string): Promise<void>
}
