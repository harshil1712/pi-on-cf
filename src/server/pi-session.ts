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
import { Agent, callable, type Connection } from 'agents'
import { PiHarness, type PiModel } from 'agents/harness/pi'
import { createAI } from 'agents/models/pi-ai'
import { PI_REGISTRY_INSTANCE, type PiEventsMessage, type WorkspaceFile, type WorkspaceFileContent } from '../shared/pi-contract'
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
  'You are Pi, a coding agent running natively on Cloudflare Workers.',
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

/**
 * The container half of the session. The backend lives on this base class
 * because `withWorkspace` builds the Workspace in its constructor, where
 * base-class fields exist and subclass fields do not.
 */
class PiSessionHost extends withWorkspaceContainer(class extends Agent<Env> {}) {
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
    artifacts: env.ARTIFACTS ? { binding: env.ARTIFACTS } : undefined,
    observer: createCloudflareObserver({ tracing }),
  }
}

/**
 * One Pi session: a pi-durable conversation hosted by `PiHarness`, and a
 * Computer workspace, in one Durable Object.
 */
export class PiSession extends withWorkspace(PiSessionHost, workspaceOptions) {
  readonly model = this.modelSource()
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const workspace = await getWorkspace(this)
      this.registry.install({
        name: 'pi-on-cf',
        sections: [{ key: 'preamble', render: () => PREAMBLE, tag: false }],
        tools: createWorkspaceTools({
          workspace,
          shell: {
            defaultBackend: 'shell',
            backends: {
              shell: { description: 'Fast Worker shell with text utilities and git.' },
              javascript: { description: 'ES module run in an isolated Worker. Export a default async function; its JSON-compatible return value is the result. Top-level await of I/O is not allowed.' },
              container: { description: 'Linux container with Node.js, npm and network access.' },
            },
          },
        }),
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
    this.lifecycle.use(this.harness)
  }

  /**
   * The models pi can use and the one new sessions start with: Workers AI and
   * AI Gateway over the AI binding. Tests override this with pi-ai's faux
   * provider.
   */
  protected modelSource(): { provider: Provider; default: PiModel } {
    const ai = createAI({ binding: this.env.AI, id: this.env.AI_GATEWAY_ID || 'default' })
    return { provider: ai.provider, default: ai(this.env.AI_MODEL) }
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
    return { operationId: receipt.operationId, accepted: receipt.accepted }
  }

  @callable()
  async steer(prompt: string) {
    const receipt = await this.harness.session().steer(validPrompt(prompt))
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
  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    path = workspacePath(path)
    const workspace = await getWorkspace(this)
    const [content, stat] = await Promise.all([workspace.fs.readFile(path, 'utf8'), workspace.fs.stat(path)])
    if (!stat.isFile) throw new Error(`Not a file: ${path}`)
    return { path, content, size: stat.size, mtime: new Date(stat.mtime).toISOString() }
  }

  /**
   * Called by the registry: stop the run and the container, then drop every
   * durable trace.
   *
   * `destroy()` aborts the isolate on the next tick, which can race this RPC's
   * reply to the registry. `_cf_scheduleDestroy()` instead persists a destroy
   * marker and an alarm, so the wipe runs in its own invocation and resumes
   * there if it is interrupted. It is marked internal in the Agents SDK; it is
   * the SDK's own path for destroying an Agent from an RPC caller.
   */
  async deleteContents(): Promise<void> {
    await this.harness.abort().catch(() => false)
    await Promise.all([...this.#watches.values()].map((watch) => watch.stop()))
    this.#watches.clear()
    await this.harness.dispose()
    // Computer has no container teardown, and destroy() does not stop it, so
    // a running container would outlive the session until it idles out.
    if (this.ctx.container?.running) {
      await this.ctx.container.destroy().catch((error: unknown) => {
        console.error('Could not stop the session container', error)
      })
    }
    await this._cf_scheduleDestroy()
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

  async #touchRegistry(): Promise<void> {
    try {
      const registry = this.env.PiRegistry.getByName(PI_REGISTRY_INSTANCE)
      await registry.touchSession(this.name)
    } catch (error) {
      console.error('Could not update the session registry', error)
    }
  }
}

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
