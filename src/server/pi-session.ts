import {
  R2Bucket as mountR2Bucket,
  type DurableObjectStorageLike,
  type SyncRetryIntent,
  type SyncRetryScheduler,
  Workspace,
  type WorkspaceOptions,
  type WorkspaceStub,
} from '@cloudflare/computer'
import { createAssets } from '@cloudflare/computer/assets'
import { CloudflareContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container'
import { WorkerJavaScriptBackend } from '@cloudflare/computer/backends/worker-javascript'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { createGitClient } from '@cloudflare/computer/git'
import { createCloudflareObserver } from '@cloudflare/computer/observe/cloudflare'
import { tracing } from 'cloudflare:workers'
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
  ApplyMemoryExtractionInput,
  AppDeploymentSummary,
  AppStatus,
  CompactionSettings,
  Memory,
  MemoryKind,
  PiStreamEvent,
  SessionBranch,
  SessionIndexEvent,
  SessionOverview,
  SessionSummary,
  StoredSessionEntry,
  WorkspaceFile,
  WorkspaceFileContent,
} from '../shared/pi-contract'
import { createPiHarness, getMemoryModel, type PiHarness } from './create-pi-harness'
import { extractMemoryOperations, type MemorySourceEntry } from './memory-extractor'
import { createMemoryTool } from './memory-tools'
import { prepareManualCompaction } from './manual-compaction'
import { PiSessionStorage, type PiSessionMetadata } from './pi-session-storage'
import { toPiStreamEvent } from './stream-events'
import { PI_REGISTRY_INSTANCE } from '../shared/pi-contract'
import { createInitializeAppTool, createSessionSearchTool, createWorkspaceTools } from './workspace-tools'
import { buildApp } from './apps/build-app'
import { deployApp as deployBuiltApp } from './apps/deploy-app'
import { previewApp } from './apps/preview-runtime'
import { createSourceSnapshot } from './apps/source'
import { TemplateRepository } from './apps/template-repository'
import type { BuiltApp, TemplateSourceSummary } from './apps/types'
import { WorkersClient } from './apps/workers-client'
import type { ComputerWorkspace } from './computer-workspace'
import { migrateLegacyShellWorkspace } from './legacy-workspace-migration'

type InitializeMetadata = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'lineage'> & { name?: string }
type SessionExport = {
  metadata: PiSessionMetadata
  entries: SessionTreeEntry[]
  compaction: CompactionSettings
  files: Array<{ path: string; content: string; encoding?: 'base64' }>
  appTemplate?: TemplateSourceSummary
}

const WORKSPACE_PAGE_SIZE = 250
const MEMORY_EXTRACTION_CURSOR = 'memoryExtractionRevision'
const MEMORY_EXTRACTION_BATCH_CHARS = 30_000
const MEMORY_SOURCE_ENTRY_CHARS = 12_000
const APP_TEMPLATE_SETTING = 'appTemplate'
const APP_DEPLOYMENT_SETTING = 'appDeployment'
const COMPUTER_WORKSPACE_MIGRATION_SETTING = 'computerWorkspaceMigration'

type MemoryRegistry = {
  searchSessions(input: { query: string; limit?: number }): Promise<import('../shared/pi-contract').SessionSearchResult[]>
  getMemoryContext(): Promise<string>
  listMemories(): Promise<Memory[]>
  setMemory(input: { id?: string; kind: MemoryKind; content: string; sourceSessionId?: string }): Promise<Memory>
  deleteMemory(id: string): Promise<void>
  applyMemoryExtraction(input: ApplyMemoryExtractionInput): Promise<void>
  applyIndexEvents(sessionId: string, events: SessionIndexEvent[]): Promise<void>
}

type ComputerEnv = Env & {
  COMPUTER_R2?: R2Bucket
  COMPUTER_R2_BUCKET?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}

const SYNC_RETRY_PREFIX = 'computer:sync-retry:'

class DurableSyncRetryScheduler implements SyncRetryScheduler {
  constructor(private readonly storage: DurableObjectStorage) {}

  get(backend: string): Promise<SyncRetryIntent | undefined> {
    return this.storage.get<SyncRetryIntent>(`${SYNC_RETRY_PREFIX}${backend}`)
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    await this.storage.put(`${SYNC_RETRY_PREFIX}${intent.backend}`, intent)
    const alarm = await this.storage.getAlarm()
    if (alarm === null || intent.notBefore < alarm) await this.storage.setAlarm(intent.notBefore)
  }

  async clear(backend: string): Promise<void> {
    await this.storage.delete(`${SYNC_RETRY_PREFIX}${backend}`)
  }
}

class PiAgentBase extends Agent<Env> {}
const PiSessionBase = withWorkspaceContainer(PiAgentBase)

export class PiSession extends PiSessionBase {
  private active = false
  private harness?: PiHarness
  private memoryExtraction?: Promise<void>
  private builtApp?: BuiltApp
  private readonly sessionStorage = new PiSessionStorage(this.ctx.storage)
  private readonly session = new Session(this.sessionStorage)
  private readonly containerBackend = new CloudflareContainerBackend({
    id: 'container',
    container: () => this,
    workspace: { binding: 'PiSession', id: this.ctx.id.toString() },
  })
  private readonly retryScheduler = new DurableSyncRetryScheduler(this.ctx.storage)
  private readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: this.ctx.id.toString(),
    waitUntil: this.ctx.waitUntil.bind(this.ctx),
    backends: [
      new WorkerShellBackend({
        id: 'shell',
        loader: this.env.APP_LOADER,
        workspace: { binding: 'PiSession', id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
      new WorkerJavaScriptBackend({
        id: 'javascript',
        loader: this.env.APP_LOADER,
        root: '/',
        allowGitNetwork: true,
        allowArtifactNetwork: true,
      }),
      this.containerBackend,
    ],
    git: createGitClient(),
    defaultGitIdentity: { name: 'Pi', email: 'pi@cloudflare.invalid' },
    artifacts: { binding: this.env.APP_ARTIFACTS },
    mounts: computerMounts(this.env as ComputerEnv),
    assets: computerAssets(this.env as ComputerEnv),
    observer: createCloudflareObserver({ tracing }),
    retryScheduler: this.retryScheduler,
    useThink: true,
  }) as ComputerWorkspace

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/ws') return this.containerBackend.handleFetch(request)
    return super.fetch(request)
  }

  override async alarm(): Promise<void> {
    await super.alarm()
    const intent = await this.retryScheduler.get('container')
    if (!intent) return
    if (intent.notBefore > Date.now()) {
      const alarm = await this.ctx.storage.getAlarm()
      if (alarm === null || intent.notBefore < alarm) await this.ctx.storage.setAlarm(intent.notBefore)
      return
    }
    const outcome = await this.workspace.retryPendingSync('container')
    if (outcome.status === 'pending' || outcome.status === 'exhausted') {
      console.error('Computer container synchronization did not complete', outcome)
    }
  }

  async onStart(): Promise<void> {
    if (this.ctx.container) await this.ctx.container.setInactivityTimeout(5 * 60_000)
    if (!this.sessionStorage.getSetting<boolean>(COMPUTER_WORKSPACE_MIGRATION_SETTING)) {
      await migrateLegacyShellWorkspace(
        this.ctx.storage as unknown as DurableObjectStorageLike,
        this.workspace,
      )
      this.sessionStorage.setSetting(COMPUTER_WORKSPACE_MIGRATION_SETTING, true)
    }
    if (this.sessionStorage.isInitialized()) {
      this.scheduleMemoryExtraction()
    }
  }

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready()
    return this.workspace.stub()
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
    await this.waitUntilInitialized()
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
    await this.waitUntilInitialized()
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
    const [content, stat] = await Promise.all([this.workspace.readFile(path), this.workspace.stat(path)])
    if (content === null || !stat || stat.type !== 'file') throw new Error(`File not found: ${path}`)
    return { path, content, size: stat.size, mtime: new Date(stat.updatedAt).toISOString() }
  }

  @callable()
  async initializeApp(): Promise<AppStatus> {
    return this.withExclusiveOperation(async () => {
      await this.initializeAppTemplate()
      return this.getAppStatus()
    })
  }

  @callable()
  async getAppStatus(): Promise<AppStatus> {
    if (!this.sessionStorage.getSetting<TemplateSourceSummary>(APP_TEMPLATE_SETTING)) {
      return { initialized: false, sourceHash: '', dirty: false }
    }
    const source = await createSourceSnapshot(this.workspace)
    const deployment = this.sessionStorage.getSetting<AppDeploymentSummary>(APP_DEPLOYMENT_SETTING)
    return { initialized: true, sourceHash: source.hash, dirty: deployment?.sourceHash !== source.hash, deployment }
  }

  @callable()
  async deployApp(): Promise<AppDeploymentSummary> {
    return this.withExclusiveOperation(async () => {
      this.requireInitializedApp()
      const source = await createSourceSnapshot(this.workspace)
      const built = await this.build(source)
      const deployment = await deployBuiltApp({
        env: this.env,
        sessionId: this.sessionStorage.getMetadataSync().id,
        workspace: this.workspace,
        source,
        built,
        template: this.appTemplate(source.files.length, source.totalBytes),
      })
      this.sessionStorage.setSetting(APP_DEPLOYMENT_SETTING, deployment)
      return deployment
    })
  }

  async preview(request: Request): Promise<Response> {
    if (!this.sessionStorage.getSetting<TemplateSourceSummary>(APP_TEMPLATE_SETTING)) {
      return new Response('This session does not have an app. Initialize one first.', { status: 409 })
    }
    return this.withExclusiveOperation(async () => {
      const source = await createSourceSnapshot(this.workspace)
      return previewApp(request, await this.build(source), this.env.APP_LOADER)
    })
  }

  @callable({ streaming: true })
  async prompt(stream: StreamingResponse, prompt: string): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID || !this.env.AI_GATEWAY_TOKEN) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_TOKEN must be configured.')
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
      this.scheduleMemoryExtraction()
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
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, this.sessionStorage.getEntriesWithSeq().at(-1)?.seq ?? 0)
      for (const file of snapshot.files) {
        validatePath(file.path)
        if (this.isMountedPath(file.path)) continue
        const parent = file.path.slice(0, file.path.lastIndexOf('/')) || '/'
        if (parent !== '/') await this.workspace.mkdir(parent, { recursive: true })
        if (file.encoding === 'base64') await this.workspace.fs.writeFile(file.path, decodeBase64(file.content))
        else await this.workspace.writeFile(file.path, file.content)
      }
      if (snapshot.appTemplate) this.sessionStorage.setSetting(APP_TEMPLATE_SETTING, snapshot.appTemplate)
      if (metadata?.name) await this.session.appendSessionName(metadata.name)
      this.harness = undefined
      this.builtApp = undefined
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
    const deployment = this.sessionStorage.getSetting<AppDeploymentSummary>(APP_DEPLOYMENT_SETTING)
    if (deployment) {
      await Promise.all([
        new WorkersClient({
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          token: deploymentToken(this.env),
        }).deleteWorker(deployment.workerName),
        this.workspace.artifacts.delete('app'),
        this.env.APP_ARTIFACTS.delete(`pi-app-${this.sessionStorage.getMetadataSync().id}`),
      ])
    }
    for (const entry of await this.workspace.readDir('/')) {
      if (this.isMountedPath(entry.path)) continue
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
    const registry = this.registry()
    const sessionId = this.sessionStorage.getMetadataSync().id
    this.harness ??= createPiHarness({
      env: this.env,
      sessionId,
      storage: this.sessionStorage,
      tools: [
        ...createWorkspaceTools(this.workspace),
        createInitializeAppTool(() => this.initializeAppTemplate()),
        createSessionSearchTool(registry),
        createMemoryTool(registry, sessionId),
      ],
      memory: registry,
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
    const contents: Array<{ path: string; content: string; encoding: 'base64' }> = []
    for (const { path } of files) {
      if (this.isMountedPath(path)) continue
      const content = await this.workspace.readFileBytes(path)
      if (content !== null) contents.push({ path, content: encodeBase64(content), encoding: 'base64' })
    }
    return {
      metadata: await this.session.getMetadata(),
      entries,
      compaction: this.compactionSettings(),
      files: contents,
      appTemplate: this.sessionStorage.getSetting<TemplateSourceSummary>(APP_TEMPLATE_SETTING),
    }
  }

  private async build(source: Awaited<ReturnType<typeof createSourceSnapshot>>): Promise<BuiltApp> {
    if (this.builtApp?.sourceHash === source.hash) return this.builtApp
    this.builtApp = await buildApp(source)
    return this.builtApp
  }

  private async initializeAppTemplate(): Promise<void> {
    if (this.sessionStorage.getSetting<TemplateSourceSummary>(APP_TEMPLATE_SETTING)) return
    const template = await new TemplateRepository(this.workspace).install({
      repository: this.env.APP_TEMPLATE_REPOSITORY,
      commit: this.env.APP_TEMPLATE_COMMIT,
    })
    this.sessionStorage.setSetting(APP_TEMPLATE_SETTING, template)
    this.builtApp = undefined
  }

  private requireInitializedApp(): void {
    if (!this.sessionStorage.getSetting<TemplateSourceSummary>(APP_TEMPLATE_SETTING)) {
      throw new Error('This session does not have an app. Initialize one first.')
    }
  }

  private async waitUntilInitialized(): Promise<void> {
    for (let attempt = 0; attempt < 40 && !this.sessionStorage.isInitialized(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!this.sessionStorage.isInitialized()) throw new Error('Session has not been initialized.')
  }

  private appTemplate(fileCount: number, totalBytes: number): TemplateSourceSummary {
    return this.sessionStorage.getSetting<TemplateSourceSummary>(APP_TEMPLATE_SETTING) ?? {
      repository: this.env.APP_TEMPLATE_REPOSITORY,
      commit: this.env.APP_TEMPLATE_COMMIT,
      fileCount,
      totalBytes,
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
    return Promise.all(files.map(async (file) => await this.workspace.stat(file.path) ?? file))
  }

  private isMountedPath(path: string): boolean {
    for (const mount of this.workspace.mounts().keys()) {
      if (path === mount || path.startsWith(`${mount}/`)) return true
    }
    return false
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
    await this.registry().applyIndexEvents(this.sessionStorage.getMetadataSync().id, events)
    this.sessionStorage.acknowledgeOutbox(events.map((event) => event.eventId))
  }

  private registry(): MemoryRegistry {
    return this.env.PiRegistry.getByName(PI_REGISTRY_INSTANCE) as unknown as MemoryRegistry
  }

  private scheduleMemoryExtraction(): void {
    const previous = this.memoryExtraction
    const extraction = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(async () => {
        await this.flushOutboxToRegistry()
        await this.extractNextMemoryBatch()
      })
    this.memoryExtraction = extraction
    this.ctx.waitUntil(extraction
      .catch((error) => console.error('Could not extract session memory', error))
      .finally(() => {
        if (this.memoryExtraction === extraction) this.memoryExtraction = undefined
      }))
  }

  private async extractNextMemoryBatch(): Promise<void> {
    if (!this.env.CLOUDFLARE_ACCOUNT_ID || !this.env.AI_GATEWAY_TOKEN) return
    const cursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    const pending = this.sessionStorage.getEntriesWithSeq().filter(({ seq }) => seq > cursor)
    if (pending.length === 0) return

    const entries: MemorySourceEntry[] = []
    let characters = 0
    let throughRevision = cursor
    for (const { seq, entry } of pending) {
      const source = memorySourceEntry(entry)
      const size = source?.text.length ?? 0
      if (entries.length > 0 && characters + size > MEMORY_EXTRACTION_BATCH_CHARS) break
      throughRevision = seq
      if (source) {
        entries.push(source)
        characters += size
      }
    }
    if (entries.length === 0) {
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, throughRevision)
      return
    }

    const registry = this.registry()
    const operations = await extractMemoryOperations({
      models: this.getHarness().models,
      model: getMemoryModel(this.env),
      memories: await registry.listMemories(),
      entries,
      sessionId: this.sessionStorage.getMetadataSync().id,
    })
    await registry.applyMemoryExtraction({
      extractionId: `${this.sessionStorage.getMetadataSync().id}:${throughRevision}`,
      sessionId: this.sessionStorage.getMetadataSync().id,
      throughRevision,
      operations,
    })
    const latestCursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, Math.max(latestCursor, throughRevision))
  }
}

function computerMounts(env: ComputerEnv): WorkspaceOptions['mounts'] {
  if (!env.COMPUTER_R2) return undefined
  return {
    '/reference': mountR2Bucket(env.COMPUTER_R2, { prefix: 'reference/', mode: 'read-only' }),
  }
}

function computerAssets(env: ComputerEnv): WorkspaceOptions['assets'] {
  if (!env.COMPUTER_R2 || !env.COMPUTER_R2_BUCKET || !env.CLOUDFLARE_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return undefined
  }
  return (workspace) => createAssets({
    ws: workspace,
    bucket: env.COMPUTER_R2!,
    s3: {
      bucket: env.COMPUTER_R2_BUCKET!,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  })
}

function deploymentToken(env: Env): string {
  const token = (env as Env & { WORKERS_DEPLOY_API_TOKEN?: string }).WORKERS_DEPLOY_API_TOKEN
  if (!token) throw new Error('WORKERS_DEPLOY_API_TOKEN must be configured.')
  return token
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

function memorySourceEntry(entry: SessionTreeEntry): MemorySourceEntry | undefined {
  if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return
  let text = messageText(entry.message).trim()
  if (!text) return
  if (text.length > MEMORY_SOURCE_ENTRY_CHARS) {
    const half = MEMORY_SOURCE_ENTRY_CHARS / 2
    text = `${text.slice(0, half)}\n[...truncated for memory extraction...]\n${text.slice(-half)}`
  }
  return { id: entry.id, role: entry.message.role, text }
}

function encodeBase64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(value)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
