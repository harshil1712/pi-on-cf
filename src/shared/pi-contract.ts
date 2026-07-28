export const PI_AGENT_NAME = 'PiSession'
export const PI_AGENT_PREFIX = 'api/agents'
export const PI_SESSION_NAME = 'workspace'

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

export interface PiSessionContract {
  readonly state: unknown
  loadTranscript(): Promise<TranscriptMessage[]>
  clearTranscript(): Promise<void>
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  prompt(prompt: string): Promise<void>
}
