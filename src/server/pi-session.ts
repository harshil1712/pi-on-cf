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
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { type AgentEventStream, createRegistry, Harness } from '@earendil-works/pi-durable'
import { Agent, type AgentStaticOptions, callable, type Connection, getAgentByName } from 'agents'
import { Browser, browserRun } from 'agents/browser'
import { PiHarness, type PiModel } from 'agents/harness/pi'
import { createAI } from 'agents/models/pi-ai'
import type { SkillSource } from 'agents/skills'
import {
  PI_REGISTRY_INSTANCE,
  type BrowserTabView,
  type ModelOption,
  type PiEventsMessage,
  type PiSessionState,
  type SessionTask,
  type TaskChange,
  type WorkspaceFile,
  type WorkspaceFileContent,
} from '~/contract'
import { reduceRunStatus, type RunStatus } from '~/lib/run-status'
import { type GitHubThread, parseRepo } from './github'
import { botIdentity, repoToken } from './github-app'
import { modelOptions } from './models'
import { createSkillTools } from './skill-tools'
import { bucketSkills, builtInSkills, SkillCatalog } from './skills'
import { cloneTask, createTaskTools, listChanges, readChange, taskSection } from './task'
import { createWebTools, webToolGuidance } from './web-tools'
import { createWorkspaceTools } from './workspace-tools'
import { WORKSPACE_ROOT, workspacePath } from './workspace-root'

/**
 * Rebuildable trees the container keeps on its own disk instead of syncing
 * into the Durable Object. A synced `npm install` pulls tens of thousands of
 * files into the DO and the next reconnect pushes them all back, which
 * exceeds the isolate's memory limit and resets it on every attempt.
 */
const CONTAINER_LOCAL_PATHS = ['**/node_modules', '**/.wrangler', '**/.venv', '**/__pycache__']

/**
 * The system prompt's opening, with who the workspace's git commits as:
 * the GitHub App's bot, through Computer's `defaultGitIdentity`. Pi commits
 * there, in the shell backend, as Computer recommends; the container's git
 * is for tools that read the repository, and has no identity, so a commit
 * there fails loudly.
 */
const preamble = (identity: { name: string; email: string }, web: string[]) =>
  [
    'You are Pi, a coding agent running natively on Cloudflare Workers. You work on your own: finish the task, check your work, and report what you did.',
    `Your durable workspace is ${WORKSPACE_ROOT}. Paths are absolute and the same in every tool and backend.`,
    'Use read, write, edit, delete, ls, find and grep for files.',
    'exec runs commands on one of three backends: shell is a fast just-bash environment with text utilities and git; javascript runs an ES module in an isolated Worker with node:fs/promises, ws:git and ws:artifacts; container is a Linux machine with Node.js, npm and network access.',
    'Prefer shell for searches and text processing. Use container only for native binaries, package installs, builds, tests or networked CLIs.',
    `Dependency and tool caches (${CONTAINER_LOCAL_PATHS.join(', ')}) stay on the container's disk: only container commands can see them, and they are lost when the container is replaced, so reinstall if they are missing.`,
    `Run git in shell: it is the workspace's own git, and commits as ${identity.name} <${identity.email}> already, so do not set user.name or user.email. It takes no -c options, and has no rebase or cherry-pick.`,
    'A pipeline reports only its last command\'s exit code, so do not pipe tests, builds, lint or type checks into head, tail or grep: use set -o pipefail, or redirect the output to a file and read its end, and trust the exit code.',
    ...web,
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
/** Storage key of the GitHub issue a mention started the session from. */
const THREAD_KEY = 'pi-on-cf:github-thread'
/** Storage key of the run status last reported to the registry. */
const RUN_STATUS_KEY = 'pi-on-cf:run-status'

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
    defaultGitIdentity: botIdentity(env),
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
  /**
   * The session's persistent browser on Browser Run, when the deployment has
   * a `BROWSER` binding. Tests and previews don't, and run without it.
   */
  readonly browser = this.env.BROWSER ? new Browser({ provider: browserRun(this.env.BROWSER) }) : undefined
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const workspace = await getWorkspace(this)
      const web = this.webTools()
      this.registry.install({
        name: 'pi-on-cf',
        sections: [
          { key: 'preamble', render: () => preamble(botIdentity(this.env), webToolGuidance(web)), tag: false },
          taskSection(() => this.state.task, () => getWorkspace(this)),
        ],
        tools: [...createWorkspaceTools({
          workspace,
          shell: {
            defaultBackend: 'shell',
            backends: {
              shell: { description: 'A just-bash shell in a Worker. Starts fast, with no network. Good for cat, grep, sed, awk, jq, find, text transformations, and git (clone, status, diff, log, add, commit, branch), which works on the workspace itself. Cannot run npm, node, python or other binaries.' },
              javascript: { description: 'ES module run in an isolated Worker. Export a default async function; its JSON-compatible return value is the result. Top-level await of I/O is not allowed.' },
              container: { description: 'A full Linux container with Node.js, npm and network access: package managers, test runners, builds and native binaries. Starts much more slowly, because the container must boot.' },
            },
          },
        }), ...createTaskTools({
          workspace,
          task: () => this.state.task,
          token: (repo) => this.githubToken(repo),
          openRepository: (input) => this.#openRepository(input),
          onPullRequest: async (pullRequest) => {
            const { task } = this.state
            if (task) await this.#setTask({ ...task, pullRequest })
          },
          thread: () => this.ctx.storage.get<GitHubThread>(THREAD_KEY),
        }), ...createSkillTools({
          bucket: this.env.BUCKET,
          workspace,
          onChange: () => this.skills.reload(this.registry),
        }), ...web],
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
  /** The session's own watch, for its run status; see `onStart`. */
  #statusWatch: AgentEventStream | undefined
  #status: RunStatus = 'idle'

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    if (this.browser) this.lifecycle.use(this.browser)
    // Lifecycle disposes in reverse order, so this teardown runs before
    // the harness closes, and the browser closes last.
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
   * Pi's web tools for this session; see createWebTools. Tests override
   * this with fake sources.
   */
  protected webTools(): ToolRegistration[] {
    return createWebTools(this.env, { ctx: this.ctx, browser: this.browser })
  }

  /**
   * Where pi's Agent Skills come from: the built-in skills, then `skills/`
   * in the app's R2 bucket. Earlier sources win a name, so a shared skill
   * cannot replace a built-in one. Tests override this.
   */
  protected skillSources(): SkillSource[] {
    return [builtInSkills, bucketSkills(this.env.BUCKET)]
  }

  /**
   * The GitHub App's token for `repo`, as owner/name, which clones, pushes
   * and opens pull requests there. Tests override this.
   */
  protected githubToken(repo: string): Promise<string> {
    return repoToken(this.env, parseRepo(repo))
  }

  override fetch(request: Request): Promise<Response> {
    // computerd dials back to `/api` through the container egress.
    if (new URL(request.url).pathname === '/api') return this.container.handleFetch(request)
    return super.fetch(request)
  }

  /**
   * Runs once per isolate, on whatever wakes it first, the alarm included.
   * Watches the session's run status, and gives sockets that outlived the
   * previous isolate a fresh watch.
   *
   * How a run survives eviction: while pi has work, `PiHarness` keeps a
   * Lifecycle wake job (`pi-wake:<session>`) on the object's alarm. After an
   * eviction the alarm wakes a new isolate; the Lifecycle starts its
   * capabilities (PiHarness re-arms wake jobs for sessions with live tasks)
   * and then runs this `onStart`, inside `blockConcurrencyWhile`, before the
   * due wake job runs. Opening pi, which the status watch below does,
   * reconciles tasks left `running` back to `pending` and `pi.resume()`s the
   * scheduler, so the run carries on from its last commit; the wake job then
   * waits for it, in up-to-10-minute alarm slices. The run keeps its
   * `run_start` from before the eviction and emits no new one, so the
   * watch's first snapshot is what tells this isolate a run is pending.
   */
  override async onStart(): Promise<void> {
    // Computer creates directories on demand, but the JavaScript backend's
    // writeFile does not create parents, so the root must exist up front.
    await (await getWorkspace(this)).fs.mkdir(WORKSPACE_ROOT, { recursive: true })
    await this.#watchStatus()
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
    prompt = validPrompt(prompt)
    const receipt = await this.harness.submit(prompt)
    // Awaited, so a caller that reads the catalog next sees the title a
    // first prompt gives the session. It never throws.
    await this.#touchRegistry(prompt)
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

  /** The browser's tabs for the app to watch live; no tabs without a browser, null without a binding. */
  @callable()
  async browserLiveView(): Promise<BrowserTabView[] | null> {
    if (!this.browser) return null
    const view = await this.browser.liveView()
    return (view?.targets ?? []).filter((target) => target.type === 'page').map(({ url, title, pageUrl }) => ({ url, title, pageUrl }))
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

  /** Called by the registry when a mention on a GitHub issue starts this session, so Pi can answer there. */
  async setThread(thread: GitHubThread): Promise<void> {
    await this.ctx.storage.put(THREAD_KEY, thread)
  }

  /**
   * Clone a repository as this session's task, when the model calls
   * `clone_repository`. Pi runs a round's tool calls in order, so two clones
   * cannot race.
   */
  async #openRepository(input: { repo: string; baseBranch?: string }): Promise<SessionTask> {
    const entryId = await this.ctx.storage.get<string>(CATALOG_ENTRY_KEY) ?? this.ctx.id.toString()
    const token = await this.githubToken(input.repo)
    const task = await cloneTask(await getWorkspace(this), token, { ...input, branch: `pi/${entryId.slice(0, 8)}` })
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
    const watches = [...this.#watches.values(), ...this.#statusWatch ? [this.#statusWatch] : []]
    this.#watches.clear()
    this.#statusWatch = undefined
    await Promise.allSettled(watches.map((watch) => watch.stop()))
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

  /**
   * One watch per isolate, tied to no connection, that folds the session's
   * events into its run status and reports each change to the registry.
   * Its first report, from the snapshot, goes out even when the status has
   * not changed, so it corrects a registry left with a stale `running`:
   * the registry ignores a report of the status it already has.
   */
  async #watchStatus(): Promise<void> {
    try {
      const previous = this.#statusWatch
      this.#statusWatch = undefined
      await previous?.stop()
      this.#status = await this.ctx.storage.get<RunStatus>(RUN_STATUS_KEY) ?? 'idle'
      const stream = await this.harness.session().events()
      this.#statusWatch = stream
      await this.#reportStatus(reduceRunStatus(this.#status, [stream.snapshot]), true)
      stream.start((events) => this.#reportStatus(reduceRunStatus(this.#status, events)))
    } catch (error) {
      // The status is for display: it must not stop the session starting.
      console.error('Could not watch the session\'s run status', error)
    }
  }

  /** Record a run status, and copy it to the registry when it changed. Never throws. */
  async #reportStatus(status: RunStatus, always = false): Promise<void> {
    const changed = status !== this.#status
    if (!changed && !always) return
    try {
      if (changed) {
        this.#status = status
        await this.ctx.storage.put(RUN_STATUS_KEY, status)
      }
      const entryId = await this.ctx.storage.get<string>(CATALOG_ENTRY_KEY)
      if (!entryId) return
      const registry = await getAgentByName(this.env.PiRegistry, PI_REGISTRY_INSTANCE)
      await registry.setStatus(entryId, status)
    } catch (error) {
      console.error('Could not update the session registry', error)
    }
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

  /** The prompt titles a session that has no title yet. */
  async #touchRegistry(prompt: string): Promise<void> {
    try {
      const entryId = await this.ctx.storage.get<string>(CATALOG_ENTRY_KEY)
      if (!entryId) return
      const registry = await getAgentByName(this.env.PiRegistry, PI_REGISTRY_INSTANCE)
      await registry.touchSession(entryId, prompt)
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
