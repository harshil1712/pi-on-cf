import { tracing } from 'cloudflare:workers'
import {
  type DurableObjectStorageLike,
  getWorkspace,
  withWorkspace,
  type WorkspaceOptions,
} from '@cloudflare/computer'
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container'
import { WorkerJavaScriptBackend } from '@cloudflare/computer/backends/worker-javascript'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { createGitClient } from '@cloudflare/computer/git'
import { createCloudflareObserver } from '@cloudflare/computer/observe/cloudflare'
import type { Provider } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { type AgentEventStream, createRegistry, Harness } from '@earendil-works/pi-durable'
import { Agent, type AgentStaticOptions, callable, type Connection, getAgentByName } from 'agents'
import { PiHarness, type PiModel } from 'agents/harness/pi'
import { createAI } from 'agents/models/pi-ai'
import type { SkillSource } from 'agents/skills'
import {
  PI_REGISTRY_INSTANCE,
  type ModelOption,
  type PiEventsMessage,
  type PiSessionState,
  type Repository,
  type SessionTask,
  type TaskChange,
  type WorkspaceFile,
  type WorkspaceFileContent,
} from '~/shared/pi-contract'
import { listRepositories } from './github'
import { modelOptions } from './models'
import { createSkillTools } from './skill-tools'
import { bucketSkills, builtInSkills, SkillCatalog } from './skills'
import { cloneTask, createTaskTools, listChanges, readChange, taskSection } from './task'
import { createWorkspaceTools } from './workspace-tools'
import { WORKSPACE_ROOT, workspacePath } from './workspace-root'

/**
 * Rebuildable trees the container keeps on its own disk instead of syncing
 * into the Durable Object. A synced `npm install` pulls tens of thousands of
 * files into the DO and the next reconnect pushes them all back, which
 * exceeds the isolate's memory limit and resets it on every attempt.
 */
const CONTAINER_LOCAL_PATHS = ['**/node_modules', '**/.wrangler', '**/.venv', '**/__pycache__']

const PREAMBLE = [
  'You are Pi, a coding agent running natively on Cloudflare Workers. You work on your own: finish the task, check your work, and report what you did.',
  `Your durable workspace is ${WORKSPACE_ROOT}. Paths are absolute and the same in every tool and backend.`,
  'Use read, write, edit, delete, ls, find and grep for files.',
  'exec runs commands on one of three backends: shell is a fast just-bash environment with text utilities and git; javascript runs an ES module in an isolated Worker with node:fs/promises, ws:git and ws:artifacts; container is a Linux machine with Node.js, npm and network access.',
  'Prefer shell for searches, text processing and git. Use container only for native binaries, package installs, builds, tests or networked CLIs.',
  `Dependency and tool caches (${CONTAINER_LOCAL_PATHS.join(', ')}) stay on the container's disk: only container commands can see them, and they are lost when the container is replaced, so reinstall if they are missing.`,
].join('\n')

const FILE_LIST_LIMIT = 1000
/**
 * Computer anchors exclude globs at the listed root, so `**\/` is needed to
 * skip these at any depth. Matching the directory itself also stops the walk
 * from descending into it.
 */
const FILE_LIST_EXCLUDE = ['**/node_modules', '**/.git']

/** Storage key of this session's catalog entry ID, set by the registry. */
const CATALOG_ENTRY_KEY = 'pi-on-cf:catalog-entry'

/**
 * The container half of the session. The backend lives on this base class
 * because `withWorkspace` builds the Workspace in its constructor, where
 * base-class fields exist and subclass fields do not.
 */
class PiSessionHost extends withWorkspaceContainer(class extends Agent<Env, PiSessionState> {}) {
  readonly container = new ContainerBackend({
    id: 'container',
    container: () => this,
    workspace: { binding: 'PiSession', id: this.ctx.id.toString() },
    egress: { mode: 'direct' },
    name: 'computer',
    instance: 'standard-2',
    ignore: CONTAINER_LOCAL_PATHS,
  })
}

function workspaceOptions(self: PiSessionHost): WorkspaceOptions {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env }
  const ref = { binding: 'PiSession', id: ctx.id.toString() }
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({ id: 'shell', loader: env.LOADER, workspace: ref, ctx }),
      new WorkerJavaScriptBackend({
        id: 'javascript',
        loader: env.LOADER,
        root: WORKSPACE_ROOT,
        allowGitNetwork: true,
        allowArtifactNetwork: true,
      }),
      self.container,
    ],
    git: createGitClient(),
    defaultGitIdentity: { name: 'Pi', email: 'pi@cloudflare.invalid' },
    // Scoped to this session, so its repos can be found and deleted with it.
    artifacts: env.ARTIFACTS ? { binding: env.ARTIFACTS, sessionId: ctx.id.toString() } : undefined,
    observer: createCloudflareObserver({ tracing }),
  }
}

/**
 * One Pi session: a pi-durable conversation hosted by `PiHarness`, and a
 * Computer workspace, in one Durable Object.
 */
export class PiSession extends withWorkspace(PiSessionHost, workspaceOptions) {
  /**
   * Clients reach a session through the registry by its catalog entry ID.
   * The identity frame would hand them this Agent's physical name, which
   * the registry keeps to itself.
   */
  static override options: AgentStaticOptions = { sendIdentityOnConnect: false }

  readonly model = this.modelSource()
  // After `model`: field initializers run in order.
  override initialState: PiSessionState = { task: null, model: this.model.default.id }
  readonly registry = createRegistry()
  readonly skills = new SkillCatalog(() => this.skillSources())
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const workspace = await getWorkspace(this)
      this.registry.install({
        name: 'pi-on-cf',
        sections: [
          { key: 'preamble', render: () => PREAMBLE, tag: false },
          taskSection(() => this.state.task, () => getWorkspace(this)),
        ],
        tools: [...createWorkspaceTools({
          workspace,
          shell: {
            defaultBackend: 'shell',
            backends: {
              shell: { description: 'Fast Worker shell with text utilities and git.' },
              javascript: { description: 'ES module run in an isolated Worker. Export a default async function; its JSON-compatible return value is the result. Top-level await of I/O is not allowed.' },
              container: { description: 'Linux container with Node.js, npm and network access.' },
            },
          },
        }), ...createTaskTools({
          workspace,
          task: () => this.state.task,
          token: () => this.githubToken(),
          openRepository: (input) => this.#openRepository(input),
          onPullRequest: async (pullRequest) => {
            const { task } = this.state
            if (task) await this.#setTask({ ...task, pullRequest })
          },
        }), ...createSkillTools({
          bucket: this.env.BUCKET,
          workspace,
          onChange: () => this.skills.reload(this.registry),
        })],
      })
      // Skills are optional: an unreachable bucket must not stop pi opening.
      await this.skills.sync(this.registry).catch((error: unknown) => {
        console.error('Could not load skills', error)
      })
      const models = createModels()
      models.setProvider(this.model.provider)
      return Harness.open(storage, {
        models,
        registry: this.registry,
        // A round's tool calls run in order, so a clone finishes before the
        // log that reads it.
        settings: { toolExecution: 'sequential' },
        onReport: (error) => console.warn('pi report', error),
      }, context)
    },
    defaults: { model: this.model.default, thinkingLevel: 'medium' },
  })

  readonly #watches = new Map<string, AgentEventStream>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Lifecycle disposes in reverse order, so this teardown runs before
    // the harness closes.
    this.lifecycle.use(this.harness).use({ dispose: () => this.#teardown() })
  }

  /**
   * The models pi can use, the one new sessions start with, and the ones the
   * picker offers: Workers AI and AI Gateway over the AI binding. Every
   * choice must be on `provider`, since pi resolves models there. Tests
   * override this with pi-ai's faux provider.
   */
  protected modelSource(): { provider: Provider; default: PiModel; choices: ModelChoice[] } {
    const ai = createAI({ binding: this.env.AI, id: this.env.AI_GATEWAY_ID || 'default' })
    const choices = modelOptions(this.env.AI_MODEL).map(({ id, label }) => ({ model: ai(id), label }))
    return { provider: ai.provider, default: ai(this.env.AI_MODEL), choices }
  }

  /**
   * Where pi's Agent Skills come from: the built-in skills, then `skills/`
   * in the app's R2 bucket. Earlier sources win a name, so a shared skill
   * cannot replace a built-in one. Tests override this.
   */
  protected skillSources(): SkillSource[] {
    return [builtInSkills, bucketSkills(this.env.BUCKET)]
  }

  /** The token that clones, pushes and opens pull requests. Tests override this. */
  protected githubToken(): string | undefined {
    return this.env.GITHUB_TOKEN || undefined
  }

  override fetch(request: Request): Promise<Response> {
    // computerd dials back to `/api` through the container egress.
    if (new URL(request.url).pathname === '/api') return this.container.handleFetch(request)
    return super.fetch(request)
  }

  /** Give sockets that outlived the previous isolate a fresh watch. */
  override async onStart(): Promise<void> {
    // Computer creates directories on demand, but the JavaScript backend's
    // writeFile does not create parents, so the root must exist up front.
    await (await getWorkspace(this)).fs.mkdir(WORKSPACE_ROOT, { recursive: true })
    // Sessions from before the picker kept no model in their state, and run on the default.
    if (!this.state.model) this.setState({ ...this.state, model: this.model.default.id })
    for (const connection of this.getConnections()) await this.#watch(connection)
  }

  override async onConnect(connection: Connection): Promise<void> {
    await this.#watch(connection)
  }

  override async onClose(connection: Connection): Promise<void> {
    await this.#unwatch(connection)
  }

  @callable()
  async submit(prompt: string) {
    const receipt = await this.harness.submit(validPrompt(prompt))
    this.ctx.waitUntil(this.#touchRegistry())
    this.ctx.waitUntil(this.#syncSkills())
    return { operationId: receipt.operationId, accepted: receipt.accepted }
  }

  @callable()
  async steer(prompt: string) {
    const receipt = await this.harness.session().steer(validPrompt(prompt))
    this.ctx.waitUntil(this.#syncSkills())
    return { operationId: receipt.operationId, accepted: receipt.accepted }
  }

  /**
   * Start aborting the run and return. Pi settles the abort only once every
   * tool has honored its signal, which can outlast a browser RPC timeout; the
   * event stream reports when the session is idle.
   */
  @callable()
  abort(): void {
    this.ctx.waitUntil(this.harness.abort().catch((error: unknown) => {
      console.error('Could not abort the session', error)
    }))
  }

  @callable()
  listModels(): ModelOption[] {
    return this.model.choices.map(({ model, label }) => ({ id: model.id, label }))
  }

  /** Switch the session's model. Pi uses it from its next model request. */
  @callable()
  async setModel(id: string): Promise<void> {
    const choice = this.model.choices.find(({ model }) => model.id === id)
    if (!choice) throw new Error(`Unknown model: ${id}`)
    await this.harness.session().setModel(choice.model)
    this.setState({ ...this.state, model: id })
  }

  @callable()
  async listFiles(): Promise<WorkspaceFile[]> {
    const workspace = await getWorkspace(this)
    const found = await workspace.fs.find(WORKSPACE_ROOT, '**', {
      exclude: FILE_LIST_EXCLUDE,
      limit: FILE_LIST_LIMIT,
    })
    const files = await Promise.all(found
      .filter((entry) => entry.type === 'file')
      .map(async ({ path }) => {
        const stat = await workspace.fs.stat(path)
        return { path, size: stat.size, mtime: new Date(stat.mtime).toISOString() }
      }))
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  @callable()
  async listRepositories(): Promise<Repository[]> {
    const token = this.githubToken()
    if (!token) throw new Error('Set the GITHUB_TOKEN secret to work on GitHub repositories.')
    return listRepositories(token)
  }

  @callable()
  async listChanges(): Promise<TaskChange[]> {
    const { task } = this.state
    return task ? listChanges(await getWorkspace(this), task) : []
  }

  @callable()
  async readChange(path: string): Promise<string> {
    const { task } = this.state
    if (!task) throw new Error('This session has no repository.')
    return readChange(await getWorkspace(this), task, path)
  }

  @callable()
  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    path = workspacePath(path)
    const workspace = await getWorkspace(this)
    const [content, stat] = await Promise.all([workspace.fs.readFile(path, 'utf8'), workspace.fs.stat(path)])
    if (!stat.isFile) throw new Error(`Not a file: ${path}`)
    return { path, content, size: stat.size, mtime: new Date(stat.mtime).toISOString() }
  }

  /** The task, its branch and pull request, are the server's to change. */
  override validateStateChange(_next: PiSessionState, source: Connection | 'server'): void {
    if (source !== 'server') throw new Error('Session state is read-only.')
  }

  /**
   * Called by the registry once, at creation: the catalog entry ID this
   * session reports its activity under.
   */
  async joinCatalog(entryId: string): Promise<void> {
    await this.ctx.storage.put(CATALOG_ENTRY_KEY, entryId)
  }

  /**
   * Clone a repository as this session's task, when the model calls
   * `clone_repository`. Pi runs a round's tool calls in order, so two clones
   * cannot race.
   */
  async #openRepository(input: { repo: string; baseBranch?: string }): Promise<SessionTask> {
    const entryId = await this.ctx.storage.get<string>(CATALOG_ENTRY_KEY) ?? this.ctx.id.toString()
    const task = await cloneTask(await getWorkspace(this), this.githubToken(), { ...input, branch: `pi/${entryId.slice(0, 8)}` })
    await this.#setTask(task)
    return task
  }

  /** Set the task, and copy what the catalog lists to the registry. */
  async #setTask(task: SessionTask): Promise<void> {
    this.setState({ ...this.state, task })
    // The catalog's copy is for display: failing to update it must not fail the caller.
    try {
      const entryId = await this.ctx.storage.get<string>(CATALOG_ENTRY_KEY)
      if (!entryId) return
      const registry = await getAgentByName(this.env.PiRegistry, PI_REGISTRY_INSTANCE)
      await registry.setTask(entryId, { repo: task.repo, branch: task.branch, ...(task.pullRequest ? { pullRequest: task.pullRequest } : {}) })
    } catch (error) {
      console.error('Could not update the session registry', error)
    }
  }

  /**
   * Runs when the registry deletes this session: `RoutedAgents` condemns the
   * Agent, and `destroy()` disposes its Lifecycle before it wipes storage.
   * Computer has no container teardown, and `destroy()` does not stop the
   * container, so it would outlive the session until it idled out. It never
   * throws, so the wipe that follows always runs.
   */
  async #teardown(): Promise<void> {
    await Promise.allSettled([...this.#watches.values()].map((watch) => watch.stop()))
    this.#watches.clear()
    if (this.ctx.container?.running) {
      await this.ctx.container.destroy().catch((error: unknown) => {
        console.error('Could not stop the session container', error)
      })
    }
    // Artifacts repos live outside the object's storage, so the wipe misses them.
    if (this.env.ARTIFACTS) {
      try {
        const { artifacts } = await getWorkspace(this)
        const repos = await artifacts.list() as { name: string }[]
        await Promise.all(repos.map((repo) => artifacts.delete(repo.name)))
      } catch (error) {
        console.error('Could not delete the session\'s Artifacts repos', error)
      }
    }
  }

  async #watch(connection: Connection): Promise<void> {
    await this.#unwatch(connection)
    const stream = await this.harness.session().events()
    this.#watches.set(connection.id, stream)
    send(connection, { type: 'pi:events', events: [stream.snapshot] })
    stream.start(async (events) => {
      if (connection.readyState !== WebSocket.OPEN) {
        await this.#unwatch(connection)
        return
      }
      send(connection, { type: 'pi:events', events })
    })
  }

  async #unwatch(connection: Connection): Promise<void> {
    const watch = this.#watches.get(connection.id)
    if (!watch) return
    this.#watches.delete(connection.id)
    await watch.stop()
  }

  /**
   * Pick up skills added to or changed in the bucket. Runs beside the turn:
   * the source lists the bucket at most once a minute, and pi applies a new
   * catalog from its next model request.
   */
  async #syncSkills(): Promise<void> {
    try {
      await this.harness.pi()
      await this.skills.sync(this.registry)
    } catch (error) {
      console.error('Could not refresh skills', error)
    }
  }

  async #touchRegistry(): Promise<void> {
    try {
      const entryId = await this.ctx.storage.get<string>(CATALOG_ENTRY_KEY)
      if (!entryId) return
      const registry = await getAgentByName(this.env.PiRegistry, PI_REGISTRY_INSTANCE)
      await registry.touchSession(entryId)
    } catch (error) {
      console.error('Could not update the session registry', error)
    }
  }
}

/** A model the picker offers, as pi resolves it and as the page shows it. */
export type ModelChoice = { model: PiModel; label: string }

function send(connection: Connection, message: PiEventsMessage): void {
  try {
    connection.send(JSON.stringify(message))
  } catch {
    // The socket closed between the event and the send.
  }
}

function validPrompt(prompt: string): string {
  prompt = prompt.trim()
  if (!prompt) throw new Error('A prompt is required.')
  if (prompt.length > 20_000) throw new Error('Prompt exceeds 20,000 characters.')
  return prompt
}
