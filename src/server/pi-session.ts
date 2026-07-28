import { Workspace, createWorkspaceStateBackend } from '@cloudflare/shell'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { Agent, callable } from 'agents'
import type { StreamingResponse } from 'agents'
import type { PiStreamEvent, TranscriptMessage, WorkspaceFile, WorkspaceFileContent } from '../shared/pi-contract'
import { createPiAgent } from './create-pi-agent'
import { toPiStreamEvent } from './stream-events'
import { createWorkspaceTools } from './workspace-tools'

export class PiSession extends Agent<Env> {
  private active = false

  private readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.toString(),
  })

  private readonly workspaceState = createWorkspaceStateBackend(this.workspace)

  private sendEvent(stream: StreamingResponse, event: Parameters<typeof toPiStreamEvent>[0]) {
    const payload = toPiStreamEvent(event)
    if (payload) stream.send(payload)
  }

  @callable()
  async loadTranscript(): Promise<TranscriptMessage[]> {
    return (await this.ctx.storage.get<AgentMessage[]>('messages')) ?? []
  }

  @callable()
  async clearTranscript(): Promise<void> {
    if (this.active) throw new Error('Pi is currently running.')
    await this.ctx.storage.delete('messages')
  }

  @callable()
  async listFiles(): Promise<WorkspaceFile[]> {
    const files = await this.workspaceState.find('/', { type: 'file' })
    return files.map(({ path, size, mtime }) => ({ path, size, mtime: mtime.toISOString() }))
  }

  @callable()
  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    if (!path.startsWith('/') || path.includes('\0')) throw new Error('File path must be absolute.')

    const [content, stat] = await Promise.all([this.workspace.readFile(path), this.workspaceState.stat(path)])
    if (content === null || !stat || stat.type !== 'file') throw new Error(`File not found: ${path}`)
    return { path, content, size: stat.size, mtime: stat.mtime.toISOString() }
  }

  @callable({ streaming: true })
  async prompt(stream: StreamingResponse, prompt: string): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID || !this.env.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be configured.')
    }

    prompt = prompt.trim()
    if (!prompt) throw new Error('A prompt is required.')
    if (prompt.length > 20_000) throw new Error('Prompt exceeds 20,000 characters.')
    if (this.active) throw new Error('Pi is already running in this workspace.')

    this.active = true
    const previousMessages = (await this.ctx.storage.get<AgentMessage[]>('messages')) ?? []
    const agent = createPiAgent({
      env: this.env,
      messages: previousMessages,
      sessionId: this.ctx.id.toString(),
      tools: createWorkspaceTools(this.workspace, this.workspaceState),
    })

    agent.subscribe((event) => this.sendEvent(stream, event))

    try {
      await agent.prompt(prompt)
    } catch (error) {
      stream.send({ type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies PiStreamEvent)
    } finally {
      try {
        await this.ctx.storage.put('messages', agent.state.messages)
        this.sendEvent(stream, { type: 'done' })
      } finally {
        this.active = false
        stream.end()
      }
    }
  }
}
