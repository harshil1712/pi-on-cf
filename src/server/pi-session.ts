import { Workspace, createWorkspaceStateBackend } from '@cloudflare/shell'
import {
  DEFAULT_COMPACTION_SETTINGS,
  Session,
  compact as compactSession,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core'
import { Agent, callable } from 'agents'
import type { StreamingResponse } from 'agents'
import type {
  CompactionSettings,
  PiStreamEvent,
  SessionBranch,
  SessionIndexEvent,
  SessionOverview,
  SessionSummary,
  StoredSessionEntry,
  WorkspaceFile,
  WorkspaceFileContent,
} from '../shared/pi-contract'
import { createPiHarness, type PiHarness } from './create-pi-harness'
import { prepareManualCompaction } from './manual-compaction'
import { PiSessionStorage, type PiSessionMetadata } from './pi-session-storage'
import { toPiStreamEvent } from './stream-events'
import { PI_REGISTRY_INSTANCE } from '../shared/pi-contract'
import { createSessionSearchTool, createWorkspaceTools } from './workspace-tools'

type InitializeMetadata = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'lineage'> & { name?: string }
type SessionExport = {
  metadata: PiSessionMetadata
  entries: SessionTreeEntry[]
  compaction: CompactionSettings
  files: Array<{ path: string; content: string }>
}

const WORKSPACE_PAGE_SIZE = 250

export class PiSession extends Agent<Env> {
  private active = false
  private harness?: PiHarness
  private readonly sessionStorage = new PiSessionStorage(this.ctx.storage)
  private readonly session = new Session(this.sessionStorage)
  private readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.toString(),
  })
  private readonly workspaceState = createWorkspaceStateBackend(this.workspace)

  async onStart(): Promise<void> {
    if (this.sessionStorage.isInitialized()) {
      this.ctx.waitUntil(this.flushOutboxToRegistry().catch((error) => console.error('Could not index session', error)))
    }
  }

  async initialize(metadata: InitializeMetadata): Promise<SessionOverview> {
    const created = this.sessionStorage.initialize({
      id: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      lineage: metadata.lineage,
    })
    if (created && metadata.name) await this.session.appendSessionName(metadata.name)
    return this.getOverview()
  }

  @callable()
  async getOverview(): Promise<SessionOverview> {
    const metadata = await this.session.getMetadata()
    const rows = this.sessionStorage.getEntriesWithSeq()
    const leafId = await this.session.getLeafId()
    const activePath = new Set((await this.sessionStorage.getPathToRoot(leafId)).map((entry) => entry.id))
    const parentIds = new Set(rows.map(({ entry }) => entry.parentId).filter((id): id is string => id !== null))
    const stats = await this.session.getSessionStats()
    const labels = new Map<string, string | undefined>()
    for (const { entry } of rows) {
      if (entry.type === 'label') labels.set(entry.targetId, entry.label?.trim() || undefined)
    }
    return {
      id: metadata.id,
      name: await this.session.getSessionName(),
      status: 'ready',
      createdAt: metadata.createdAt,
      updatedAt: rows.at(-1)?.entry.timestamp ?? metadata.updatedAt,
      messageCount: stats.messageCount,
      activeLeafId: leafId,
      lineage: metadata.lineage,
      revision: rows.at(-1)?.seq ?? 0,
      compaction: this.compactionSettings(),
      tree: rows.map(({ seq, entry }) => ({
        seq,
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
        role: entry.type === 'message' ? entry.message.role : undefined,
        preview: entryPreview(entry),
        label: labels.get(entry.id),
        timestamp: entry.timestamp,
        isLeaf: !parentIds.has(entry.id),
        isOnActiveBranch: activePath.has(entry.id),
      })),
    }
  }

  @callable()
  async getBranch(leafId?: string): Promise<SessionBranch> {
    const rows = this.sessionStorage.getEntriesWithSeq()
    const seqById = new Map(rows.map(({ seq, entry }) => [entry.id, seq]))
    const selectedLeaf = leafId ?? await this.session.getLeafId()
    const entries = await this.sessionStorage.getPathToRoot(selectedLeaf)
    return {
      leafId: selectedLeaf,
      revision: rows.at(-1)?.seq ?? 0,
      entries: entries.map((entry) => storedEntry(seqById.get(entry.id) ?? 0, entry)),
    }
  }

  @callable()
  async navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string }> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      const result = await this.getHarness().navigateTree(entryId, options)
      await this.flushOutboxToRegistry()
      return { editorText: result.editorText }
    } finally {
      this.active = false
    }
  }

  @callable()
  async setSessionName(name: string): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      await this.session.appendSessionName(name)
      await this.flushOutboxToRegistry()
      return this.getOverview()
    })
  }

  @callable()
  async setEntryLabel(entryId: string, label?: string): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      await this.session.appendLabel(entryId, label)
      await this.flushOutboxToRegistry()
      return this.getOverview()
    })
  }

  @callable()
  async compact(focus?: string): Promise<{ summary: string; tokensBefore: number }> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      const result = await this.runCompaction(this.getHarness(), this.compactionSettings(), focus, true)
      await this.flushOutboxToRegistry()
      return result
    } finally {
      this.active = false
    }
  }

  @callable()
  async updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings> {
    if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens < 0 ||
        !Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0) {
      throw new Error('Compaction token settings must be non-negative integers.')
    }
    return this.withExclusiveOperation(async () => {
      const value = { ...settings }
      this.sessionStorage.setSetting('compaction', value)
      return value
    })
  }

  @callable()
  async steer(prompt: string): Promise<void> {
    await this.getHarness().steer(validPrompt(prompt))
  }

  @callable()
  async followUp(prompt: string): Promise<void> {
    await this.getHarness().followUp(validPrompt(prompt))
  }

  @callable()
  async abort(): Promise<void> {
    await this.getHarness().abort()
  }

  @callable()
  async listFiles(): Promise<WorkspaceFile[]> {
    const files = await this.listAllWorkspaceFiles()
    return files.map(({ path, size, updatedAt }) => ({ path, size, mtime: new Date(updatedAt).toISOString() }))
  }

  @callable()
  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    validatePath(path)
    const [content, stat] = await Promise.all([this.workspace.readFile(path), this.workspaceState.stat(path)])
    if (content === null || !stat || stat.type !== 'file') throw new Error(`File not found: ${path}`)
    return { path, content, size: stat.size, mtime: stat.mtime.toISOString() }
  }

  @callable({ streaming: true })
  async prompt(stream: StreamingResponse, prompt: string): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID || !this.env.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be configured.')
    }
    prompt = validPrompt(prompt)
    if (this.active) throw new Error('Pi is already running in this workspace.')

    this.active = true
    const harness = this.getHarness()
    const unsubscribe = harness.subscribe((event) => {
      const payload = toPiStreamEvent(event)
      if (payload) stream.send(payload)
      if (event.type === 'save_point') {
        this.ctx.waitUntil(this.flushOutboxToRegistry().catch((error) => console.error('Could not index session', error)))
      }
    })
    try {
      await this.compactIfNeeded(harness)
      await harness.prompt(prompt)
    } catch (error) {
      stream.send({ type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies PiStreamEvent)
    } finally {
      unsubscribe()
      this.active = false
      stream.send({ type: 'done' } satisfies PiStreamEvent)
      stream.end()
      this.ctx.waitUntil(this.flushOutboxToRegistry().catch((error) => console.error('Could not index session', error)))
    }
  }

  async exportSession(entryId?: string): Promise<SessionExport> {
    return this.withExclusiveOperation(() => this.createExport(entryId))
  }

  async exportFork(entryId: string): Promise<SessionExport> {
    return this.withExclusiveOperation(async () => {
      const target = await this.session.getEntry(entryId)
      if (!target || target.type !== 'message' || target.message.role !== 'user') {
        throw new Error('A fork must select a user message on the source branch.')
      }
      return this.createExport(target.parentId ?? undefined)
    })
  }

  async exportClone(): Promise<SessionExport> {
    return this.withExclusiveOperation(async () => this.createExport((await this.session.getLeafId()) ?? undefined))
  }

  async importSession(snapshot: SessionExport, metadata?: InitializeMetadata): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      const targetMetadata: PiSessionMetadata = metadata ? {
        id: metadata.id,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        lineage: metadata.lineage,
      } : snapshot.metadata
      this.sessionStorage.replace(targetMetadata, snapshot.entries)
      this.sessionStorage.setSetting('compaction', snapshot.compaction)
      for (const file of snapshot.files) {
        validatePath(file.path)
        await this.workspace.mkdir(file.path.slice(0, file.path.lastIndexOf('/')) || '/', { recursive: true })
        await this.workspace.writeFile(file.path, file.content)
      }
      if (metadata?.name) await this.session.appendSessionName(metadata.name)
      this.harness = undefined
      return this.getOverview()
    })
  }

  async deleteContents(): Promise<void> {
    if (this.active) {
      const harness = this.getHarness()
      await harness.abort()
      await harness.waitForIdle()
    }
    this.active = true
    for (const entry of await this.workspace.readDir('/')) {
      await this.workspace.rm(entry.path, { recursive: true, force: true })
    }
    await this.destroy()
  }

  // TODO: push these to PiRegistry when that binding is present in the generated Env type.
  async flushOutbox(): Promise<SessionIndexEvent[]> {
    return this.sessionStorage.getOutbox() as SessionIndexEvent[]
  }

  async acknowledgeOutbox(eventIds: string[]): Promise<void> {
    this.sessionStorage.acknowledgeOutbox(eventIds)
  }

  private getHarness(): PiHarness {
    const registry = this.env.PiRegistry.getByName(PI_REGISTRY_INSTANCE) as unknown as {
      searchSessions(input: { query: string; limit?: number }): Promise<import('../shared/pi-contract').SessionSearchResult[]>
    }
    this.harness ??= createPiHarness({
      env: this.env,
      sessionId: this.sessionStorage.getMetadataSync().id,
      storage: this.sessionStorage,
      tools: [...createWorkspaceTools(this.workspace, this.workspaceState), createSessionSearchTool(registry)],
    })
    return this.harness
  }

  private compactionSettings(): CompactionSettings {
    return this.sessionStorage.getSetting<CompactionSettings>('compaction') ?? { ...DEFAULT_COMPACTION_SETTINGS }
  }

  private async compactIfNeeded(harness: PiHarness): Promise<void> {
    const settings = this.compactionSettings()
    if (!settings.enabled) return
    const context = await this.session.buildContext()
    const estimate = estimateContextTokens(context.messages)
    if (!shouldCompact(estimate.tokens, harness.getModel().contextWindow, settings)) return
    await this.runCompaction(harness, settings)
  }

  private async runCompaction(harness: PiHarness, settings: CompactionSettings, focus?: string, manual = false) {
    const entries = await this.session.getBranch()
    const preparation = manual ? prepareManualCompaction(entries, settings) : prepareCompaction(entries, settings)
    if (!preparation.ok) throw preparation.error
    if (!preparation.value) throw new Error('Nothing to compact')
    if (preparation.value.messagesToSummarize.length === 0 && preparation.value.turnPrefixMessages.length === 0) {
      throw new Error('Nothing to compact')
    }
    const result = await compactSession(
      preparation.value,
      harness.models,
      harness.getModel(),
      focus,
      undefined,
      harness.getThinkingLevel(),
    )
    if (!result.ok) throw result.error
    await this.session.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
      result.value.details,
      false,
      result.value.usage,
      result.value.retainedTail,
    )
    return { summary: result.value.summary, tokensBefore: result.value.tokensBefore }
  }

  private async createExport(entryId?: string): Promise<SessionExport> {
    const entries = entryId ? await this.sessionStorage.getPathToRoot(entryId) : []
    const files = await this.listAllWorkspaceFiles()
    const contents: Array<{ path: string; content: string }> = []
    for (const { path } of files) {
      const content = await this.workspace.readFile(path)
      if (content !== null) contents.push({ path, content })
    }
    return {
      metadata: await this.session.getMetadata(),
      entries,
      compaction: this.compactionSettings(),
      files: contents,
    }
  }

  private async listAllWorkspaceFiles() {
    const files: Awaited<ReturnType<typeof this.workspace.readDir>> = []
    const directories = ['/']
    while (directories.length > 0) {
      const directory = directories.pop()!
      for (let offset = 0; ; offset += WORKSPACE_PAGE_SIZE) {
        const entries = await this.workspace.readDir(directory, { limit: WORKSPACE_PAGE_SIZE, offset })
        for (const entry of entries) {
          if (entry.type === 'directory') directories.push(entry.path)
          else if (entry.type === 'file') files.push(entry)
        }
        if (entries.length < WORKSPACE_PAGE_SIZE) break
      }
    }
    return files
  }

  private async withExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }

  private async flushOutboxToRegistry(): Promise<void> {
    const events = this.sessionStorage.getOutbox() as SessionIndexEvent[]
    if (events.length === 0) return
    const registry = this.env.PiRegistry.getByName(PI_REGISTRY_INSTANCE) as unknown as {
      applyIndexEvents(sessionId: string, events: SessionIndexEvent[]): Promise<void>
    }
    await registry.applyIndexEvents(this.sessionStorage.getMetadataSync().id, events)
    this.sessionStorage.acknowledgeOutbox(events.map((event) => event.eventId))
  }
}

function validPrompt(prompt: string): string {
  prompt = prompt.trim()
  if (!prompt) throw new Error('A prompt is required.')
  if (prompt.length > 20_000) throw new Error('Prompt exceeds 20,000 characters.')
  return prompt
}

function validatePath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('File path must be absolute.')
}

function storedEntry(seq: number, entry: SessionTreeEntry): StoredSessionEntry {
  return {
    seq,
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
    message: entry.type === 'message' ? entry.message : undefined,
    summary: entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.summary : undefined,
    firstKeptEntryId: entry.type === 'compaction' ? entry.firstKeptEntryId : undefined,
    targetId: entry.type === 'leaf' ? entry.targetId : entry.type === 'label' ? entry.targetId : undefined,
    label: entry.type === 'label' ? entry.label : undefined,
    name: entry.type === 'session_info' ? entry.name : undefined,
  }
}

function entryPreview(entry: SessionTreeEntry): string {
  let value = ''
  if (entry.type === 'message') value = messageText(entry.message)
  else if (entry.type === 'compaction' || entry.type === 'branch_summary') value = entry.summary
  else if (entry.type === 'session_info') value = entry.name ?? ''
  else if (entry.type === 'label') value = entry.label ?? ''
  else if (entry.type === 'custom_message') value = messageText(entry.content)
  return value.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function messageText(message: unknown): string {
  const content = typeof message === 'object' && message !== null && 'content' in message
    ? message.content
    : message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
}
