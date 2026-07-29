export const PI_AGENT_NAME = 'PiSession'
export const PI_REGISTRY_NAME = 'PiRegistry'
export const PI_AGENT_PREFIX = 'api/agents'
export const PI_REGISTRY_INSTANCE = 'singleton'

export type PiStreamEvent =
  | { type: 'text_start' | 'text_end' | 'thinking_start' | 'thinking_end' | 'done' }
  | { type: 'text_delta' | 'thinking_delta'; delta: string }
  | { type: 'tool_execution_start'; callId: string; name: string; args: unknown }
  | { type: 'tool_execution_end'; callId: string; name: string; isError: boolean }
  | { type: 'error'; error: string }

export type WorkspaceFile = {
  path: string
  size: number
  mtime: string
}

export type WorkspaceFileContent = WorkspaceFile & {
  content: string
}

export type TranscriptMessage = {
  role?: string
  content?: unknown
}

export type SessionStatus = 'creating' | 'ready' | 'deleting' | 'error'
export type SessionLineage = {
  type: 'new' | 'fork' | 'clone'
  parentSessionId?: string
  sourceEntryId?: string
}

export type SessionSummary = {
  id: string
  name?: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  messageCount: number
  activeLeafId: string | null
  lineage: SessionLineage
}

export type SessionTreeNode = {
  seq: number
  id: string
  parentId: string | null
  type: string
  role?: string
  preview: string
  label?: string
  timestamp: string
  isLeaf: boolean
  isOnActiveBranch: boolean
}

export type StoredSessionEntry = {
  seq: number
  id: string
  parentId: string | null
  type: string
  timestamp: string
  message?: TranscriptMessage
  summary?: string
  firstKeptEntryId?: string
  targetId?: string | null
  label?: string
  name?: string
}

export type SessionOverview = SessionSummary & {
  revision: number
  tree: SessionTreeNode[]
  compaction: CompactionSettings
}

export type SessionBranch = {
  leafId: string | null
  revision: number
  entries: StoredSessionEntry[]
}

export type CompactionSettings = {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

export type SessionSearchResult = {
  session: SessionSummary
  matches: Array<{
    entryId: string
    role: string
    timestamp: string
    text: string
  }>
}

export type SessionListInput = {
  query?: string
  limit?: number
  sort?: 'recent' | 'relevance' | 'threaded'
  namedOnly?: boolean
}

export type SessionIndexEvent =
  | { eventId: string; type: 'message'; entryId: string; entrySeq: number; role: string; timestamp: string; text: string }
  | { eventId: string; type: 'touch'; updatedAt: string; messageCount: number; activeLeafId: string | null }
  | { eventId: string; type: 'rename'; name?: string }
  | { eventId: string; type: 'delete' }

export type MemoryKind = 'preference' | 'fact' | 'instruction' | 'decision'

export type Memory = {
  id: string
  kind: MemoryKind
  content: string
  sourceSessionId?: string
  sourceEntryId?: string
  createdAt: string
  updatedAt: string
}

export type MemoryExtractionOperation =
  | { action: 'add'; kind: MemoryKind; content: string; sourceEntryId: string }
  | { action: 'update'; id: string; expectedUpdatedAt: string; kind: MemoryKind; content: string; sourceEntryId: string }
  | { action: 'delete'; id: string; expectedUpdatedAt: string; sourceEntryId: string }

export type ApplyMemoryExtractionInput = {
  extractionId: string
  sessionId: string
  throughRevision: number
  operations: MemoryExtractionOperation[]
}

export interface PiSessionContract {
  readonly state: unknown
  getOverview(): Promise<SessionOverview>
  getBranch(leafId?: string): Promise<SessionBranch>
  navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string }>
  setSessionName(name: string): Promise<SessionOverview>
  setEntryLabel(entryId: string, label?: string): Promise<SessionOverview>
  compact(focus?: string): Promise<{ summary: string; tokensBefore: number }>
  updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings>
  steer(prompt: string): Promise<void>
  followUp(prompt: string): Promise<void>
  abort(): Promise<void>
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  prompt(prompt: string): Promise<void>
}

export interface PiRegistryContract {
  readonly state: unknown
  createSession(input?: { name?: string }): Promise<SessionSummary>
  listSessions(input?: SessionListInput): Promise<SessionSummary[]>
  searchSessions(input: SessionListInput): Promise<SessionSearchResult[]>
  renameSession(sessionId: string, name?: string): Promise<SessionSummary>
  deleteSession(sessionId: string): Promise<void>
  forkSession(input: { sourceSessionId: string; entryId: string; name?: string }): Promise<SessionSummary>
  cloneSession(input: { sourceSessionId: string; name?: string }): Promise<SessionSummary>
}
