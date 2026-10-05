import type { AgentEvent } from '@earendil-works/pi-durable'

export const PI_AGENT_NAME = 'PiSession'
export const PI_REGISTRY_NAME = 'PiRegistry'
export const PI_AGENT_PREFIX = 'api/agents'
export const PI_REGISTRY_INSTANCE = 'singleton'

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

export type SessionSummary = {
  id: string
  name?: string
  createdAt: string
  updatedAt: string
}

export interface PiSessionContract {
  readonly state: unknown
  submit(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  steer(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  abort(): void
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
}

export interface PiRegistryContract {
  readonly state: unknown
  createSession(input?: { name?: string }): Promise<SessionSummary>
  getSession(sessionId: string): Promise<SessionSummary | null>
  listSessions(): Promise<SessionSummary[]>
  renameSession(sessionId: string, name?: string): Promise<SessionSummary>
  deleteSession(sessionId: string): Promise<void>
}
