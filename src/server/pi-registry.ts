import { Agent, callable } from 'agents'
import type { SessionSummary } from '../shared/pi-contract'

type SessionRow = {
  id: string
  name: string | null
  created_at: string
  updated_at: string
}

const MAX_NAME_LENGTH = 120

/** The singleton catalog of sessions. Each session's state lives in its own PiSession. */
export class PiRegistry extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_catalog_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pi_catalog_sessions_updated
        ON pi_catalog_sessions(updated_at DESC);
    `)
  }

  @callable()
  async createSession(input: { name?: string } = {}): Promise<SessionSummary> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      'INSERT INTO pi_catalog_sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      id, cleanName(input.name) ?? null, now, now,
    )
    return this.requireSession(id)
  }

  @callable()
  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return this.findSession(sessionId)
  }

  @callable()
  async listSessions(): Promise<SessionSummary[]> {
    return this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM pi_catalog_sessions ORDER BY updated_at DESC').toArray().map(summary)
  }

  @callable()
  async renameSession(sessionId: string, name?: string): Promise<SessionSummary> {
    this.requireSession(sessionId)
    this.ctx.storage.sql.exec(
      'UPDATE pi_catalog_sessions SET name = ?, updated_at = ? WHERE id = ?',
      cleanName(name) ?? null, new Date().toISOString(), sessionId,
    )
    return this.requireSession(sessionId)
  }

  @callable()
  async deleteSession(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    const session = this.env.PiSession.getByName(sessionId)
    await session.deleteContents()
    this.ctx.storage.sql.exec('DELETE FROM pi_catalog_sessions WHERE id = ?', sessionId)
  }

  /** Called by a PiSession when it accepts a prompt. */
  async touchSession(sessionId: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE pi_catalog_sessions SET updated_at = ? WHERE id = ?', new Date().toISOString(), sessionId)
  }

  private findSession(sessionId: string): SessionSummary | null {
    const row = this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM pi_catalog_sessions WHERE id = ?', sessionId).toArray()[0]
    return row ? summary(row) : null
  }

  private requireSession(sessionId: string): SessionSummary {
    const session = this.findSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }
}

function summary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    ...(row.name ? { name: row.name } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function cleanName(name: string | undefined): string | undefined {
  const value = name?.trim()
  if (!value) return undefined
  if (value.length > MAX_NAME_LENGTH) throw new Error(`Session names are limited to ${MAX_NAME_LENGTH} characters.`)
  return value
}
