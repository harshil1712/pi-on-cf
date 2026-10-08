import { Agent, callable } from 'agents'
import { type RoutedAgentEntry, RoutedAgents } from 'agents/routing'
import { PI_SESSIONS_ROUTE, type PullRequest, type SessionSummary } from '~/shared/pi-contract'
import type { PiSession } from './pi-session'

type SessionMetadata = {
  name?: string
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
 */
export class PiRegistry extends Agent<Env> {
  readonly sessions = new RoutedAgents<PiSession, SessionMetadata>({
    namespace: this.env.PiSession,
    route: PI_SESSIONS_ROUTE,
  })

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.lifecycle.use(this.sessions)
  }

  @callable()
  async createSession(input: { name?: string } = {}): Promise<SessionSummary> {
    const name = cleanName(input.name)
    const entry = await this.sessions.create({ metadata: name ? { name } : {} })
    // The session reports activity under its entry ID, which only the
    // registry knows. Without it the entry is unusable, so undo the create.
    try {
      const session = await this.sessions.get(entry.id)
      if (!session) throw new Error(`Session not found: ${entry.id}`)
      await session.joinCatalog(entry.id)
    } catch (error) {
      await this.sessions.delete(entry.id)
      throw error
    }
    return summary(entry)
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
    return summary(await this.#require(sessionId))
  }

  @callable()
  async deleteSession(sessionId: string): Promise<void> {
    if (!await this.sessions.delete(sessionId)) throw new Error(`Session not found: ${sessionId}`)
  }

  /** Called by a PiSession when it clones its repository and when it opens a pull request. */
  async setTask(sessionId: string, task: { repo: string; branch: string; pullRequest?: PullRequest }): Promise<void> {
    const entry = await this.#find(sessionId)
    if (entry) await this.sessions.setMetadata(sessionId, { ...entry.metadata, ...task })
  }

  /** Called by a PiSession when it accepts a prompt: moves the entry to the top. */
  async touchSession(sessionId: string): Promise<void> {
    const entry = await this.#find(sessionId)
    // Rewriting the same metadata bumps the entry's `updatedAt`.
    if (entry) await this.sessions.setMetadata(sessionId, entry.metadata)
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
