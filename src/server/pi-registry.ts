import { Agent, callable, type Connection } from 'agents'
import { type RoutedAgentEntry, RoutedAgents } from 'agents/routing'
import { type ModelOption, PI_SESSIONS_ROUTE, type PiRegistryState, type PullRequest, type Repository, type SessionSummary } from '~/shared/pi-contract'
import { titleFromPrompt } from '~/shared/session-title'
import { listRepositories } from './github'
import { modelOptions } from './models'
import type { PiSession } from './pi-session'

type SessionMetadata = {
  name?: string
  /** From the first prompt, for sessions nobody named. */
  title?: string
  repo?: string
  branch?: string
  pullRequest?: PullRequest
}

const MAX_NAME_LENGTH = 120

/**
 * The singleton catalog of sessions, on the Agents SDK's `RoutedAgents`.
 *
 * Each catalog entry names one `PiSession` Agent by an opaque physical
 * name that never leaves the registry. The registry forwards
 * `/sessions/{id}/...` requests and WebSocket upgrades to that Agent, which
 * then owns its socket, and deleting an entry condemns the Agent through the
 * SDK's deferred teardown. Each session's state lives in its own Agent.
 *
 * Its Agent state is a revision that every catalog change bumps. The SDK
 * syncs it to every open page, which reloads the list when it moves, so
 * the sidebar follows titles, pull requests and order without polling.
 */
export class PiRegistry extends Agent<Env, PiRegistryState> {
  override initialState: PiRegistryState = { revision: 0 }

  readonly sessions = new RoutedAgents<PiSession, SessionMetadata>({
    namespace: this.env.PiSession,
    route: PI_SESSIONS_ROUTE,
  })

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.lifecycle.use(this.sessions)
  }

  @callable()
  async createSession(input: { name?: string; prompt?: string; model?: string } = {}): Promise<SessionSummary> {
    const name = cleanName(input.name)
    // Checked here, before there is an entry to undo, so a bad model never reaches a session.
    if (input.model && !this.listModels().some(({ id }) => id === input.model)) throw new Error(`Unknown model: ${input.model}`)
    const entry = await this.sessions.create({ metadata: name ? { name } : {} })
    // The session reports activity under its entry ID, which only the
    // registry knows. Without it the entry is unusable, so undo the create.
    try {
      const session = await this.sessions.get(entry.id)
      if (!session) throw new Error(`Session not found: ${entry.id}`)
      await session.joinCatalog(entry.id)
      // Before the prompt, so pi answers it with the model the home page chose.
      if (input.model) await session.setModel(input.model)
      // The home page starts a session with its first prompt; a session
      // that cannot take it is no use to the caller either.
      if (input.prompt?.trim()) {
        // The session titles its entry before `submit` returns.
        await session.submit(input.prompt)
      }
    } catch (error) {
      await this.sessions.delete(entry.id)
      throw error
    }
    this.#changed()
    return summary(await this.#require(entry.id))
  }

  @callable()
  async getSession(sessionId: string): Promise<SessionSummary | null> {
    const entry = await this.#find(sessionId)
    return entry ? summary(entry) : null
  }

  @callable()
  async listSessions(): Promise<SessionSummary[]> {
    return (await this.sessions.list()).map(summary)
  }

  @callable()
  async renameSession(sessionId: string, name?: string): Promise<SessionSummary> {
    const entry = await this.#require(sessionId)
    const nextName = cleanName(name)
    const { name: _previous, ...metadata } = entry.metadata ?? {}
    await this.sessions.setMetadata(sessionId, nextName ? { ...metadata, name: nextName } : metadata)
    this.#changed()
    return summary(await this.#require(sessionId))
  }

  /**
   * The token's repositories, for `@` suggestions. On the registry, so the
   * home page can suggest them before any session exists.
   */
  @callable()
  async listRepositories(): Promise<Repository[]> {
    const token = this.env.GITHUB_TOKEN
    if (!token) throw new Error('Set the GITHUB_TOKEN secret to work on GitHub repositories.')
    return listRepositories(token)
  }

  /** The models a session can use, the default first, for the home page's picker. Tests override this. */
  @callable()
  listModels(): ModelOption[] {
    return modelOptions(this.env.AI_MODEL)
  }

  @callable()
  async deleteSession(sessionId: string): Promise<void> {
    if (!await this.sessions.delete(sessionId)) throw new Error(`Session not found: ${sessionId}`)
    this.#changed()
  }

  /** Called by a PiSession when it clones its repository and when it opens a pull request. */
  async setTask(sessionId: string, task: { repo: string; branch: string; pullRequest?: PullRequest }): Promise<void> {
    const entry = await this.#find(sessionId)
    if (!entry) return
    await this.sessions.setMetadata(sessionId, { ...entry.metadata, ...task })
    this.#changed()
  }

  /**
   * Called by a PiSession when it accepts a prompt: moves the entry to the
   * top, and titles it from its first prompt.
   */
  async touchSession(sessionId: string, prompt?: string): Promise<void> {
    const entry = await this.#find(sessionId)
    if (!entry) return
    const metadata = entry.metadata ?? {}
    // Rewriting the same metadata bumps the entry's `updatedAt`.
    await this.sessions.setMetadata(sessionId, !metadata.title && prompt ? { ...metadata, title: titleFromPrompt(prompt) } : metadata)
    this.#changed()
  }

  /** The revision is the registry's to move. */
  override validateStateChange(_next: PiRegistryState, source: Connection | 'server'): void {
    if (source !== 'server') throw new Error('Registry state is read-only.')
  }

  #changed(): void {
    this.setState({ revision: this.state.revision + 1 })
  }

  async #find(sessionId: string): Promise<RoutedAgentEntry<SessionMetadata> | undefined> {
    return (await this.sessions.list()).find((entry) => entry.id === sessionId)
  }

  async #require(sessionId: string): Promise<RoutedAgentEntry<SessionMetadata>> {
    const entry = await this.#find(sessionId)
    if (!entry) throw new Error(`Session not found: ${sessionId}`)
    return entry
  }
}

function summary(entry: RoutedAgentEntry<SessionMetadata>): SessionSummary {
  return {
    id: entry.id,
    ...(entry.metadata?.name ? { name: entry.metadata.name } : {}),
    ...(entry.metadata?.title ? { title: entry.metadata.title } : {}),
    ...(entry.metadata?.repo ? { repo: entry.metadata.repo, branch: entry.metadata.branch } : {}),
    ...(entry.metadata?.pullRequest ? { pullRequest: entry.metadata.pullRequest } : {}),
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
  }
}

function cleanName(name: string | undefined): string | undefined {
  const value = name?.trim()
  if (!value) return undefined
  if (value.length > MAX_NAME_LENGTH) throw new Error(`Session names are limited to ${MAX_NAME_LENGTH} characters.`)
  return value
}
