import {
  SessionError,
  uuidv7,
  type SessionEntryCursorOptions,
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core'

export type PiSessionMetadata = SessionMetadata & {
  updatedAt: string
  lineage: { type: 'new' | 'fork' | 'clone'; parentSessionId?: string; sourceEntryId?: string }
}

type EntryRow = { seq: number; id: string; type: string; entry: string }
type MetadataRow = { value: string }

const leafAfter = (entry: SessionTreeEntry) => entry.type === 'leaf' ? entry.targetId : entry.id

function usageFor(entry: SessionTreeEntry) {
  if (entry.type === 'message' && entry.message.role === 'assistant') return entry.message.usage
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return entry.usage
}

export class PiSessionStorage implements SessionStorage<PiSessionMetadata> {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_session_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_session_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        entry TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pi_session_entries_type ON pi_session_entries(type, seq);
      CREATE TABLE IF NOT EXISTS pi_session_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_session_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL
      );
    `)
  }

  initialize(metadata: PiSessionMetadata): boolean {
    const existing = this.storage.sql.exec<MetadataRow>(
      "SELECT value FROM pi_session_metadata WHERE key = 'metadata'",
    ).toArray()[0]
    if (existing) return false
    this.storage.sql.exec(
      "INSERT INTO pi_session_metadata(key, value) VALUES ('metadata', ?)",
      JSON.stringify(metadata),
    )
    return true
  }

  isInitialized(): boolean {
    return this.storage.sql.exec<MetadataRow>(
      "SELECT value FROM pi_session_metadata WHERE key = 'metadata'",
    ).toArray().length !== 0
  }

  async getMetadata(): Promise<PiSessionMetadata> {
    return this.getMetadataSync()
  }

  getMetadataSync(): PiSessionMetadata {
    const row = this.storage.sql.exec<MetadataRow>(
      "SELECT value FROM pi_session_metadata WHERE key = 'metadata'",
    ).toArray()[0]
    if (!row) throw new SessionError('invalid_session', 'Session has not been initialized')
    return JSON.parse(row.value) as PiSessionMetadata
  }

  async getLeafId(): Promise<string | null> {
    const row = this.storage.sql.exec<EntryRow>(
      'SELECT seq, id, type, entry FROM pi_session_entries ORDER BY seq DESC LIMIT 1',
    ).toArray()[0]
    if (!row) return null
    const leafId = leafAfter(JSON.parse(row.entry) as SessionTreeEntry)
    if (leafId !== null && !(await this.getEntry(leafId))) {
      throw new SessionError('invalid_session', `Entry ${leafId} not found`)
    }
    return leafId
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !(await this.getEntry(leafId))) {
      throw new SessionError('not_found', `Entry ${leafId} not found`)
    }
    await this.appendEntry({
      type: 'leaf',
      id: await this.createEntryId(),
      parentId: await this.getLeafId(),
      timestamp: new Date().toISOString(),
      targetId: leafId,
    })
  }

  async createEntryId(): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = uuidv7().slice(-8)
      if (!(await this.getEntry(id))) return id
    }
    return uuidv7()
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.storage.transactionSync(() => {
      if (entry.parentId && !this.hasEntry(entry.parentId)) {
        throw new SessionError('invalid_session', `Parent entry ${entry.parentId} not found`)
      }
      if (entry.type === 'leaf' && entry.targetId && !this.hasEntry(entry.targetId)) {
        throw new SessionError('not_found', `Entry ${entry.targetId} not found`)
      }
      this.storage.sql.exec(
        'INSERT INTO pi_session_entries(id, type, entry) VALUES (?, ?, ?)',
        entry.id,
        entry.type,
        JSON.stringify(entry),
      )
      const seq = this.storage.sql.exec<{ seq: number }>('SELECT last_insert_rowid() AS seq').one().seq
      if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')) {
        const text = messageText(entry.message)
        if (text) {
          this.enqueue({
            eventId: crypto.randomUUID(),
            type: 'message',
            entryId: entry.id,
            entrySeq: seq,
            role: entry.message.role,
            timestamp: entry.timestamp,
            text,
          })
        }
      } else if (entry.type === 'session_info') {
        this.enqueue({ eventId: crypto.randomUUID(), type: 'rename', name: entry.name?.trim() || undefined })
      }
      this.enqueue({
        eventId: crypto.randomUUID(),
        type: 'touch',
        updatedAt: entry.timestamp,
        messageCount: this.countMessages(),
        activeLeafId: leafAfter(entry),
      })
    })
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const row = this.storage.sql.exec<EntryRow>(
      'SELECT seq, id, type, entry FROM pi_session_entries WHERE id = ?',
      id,
    ).toArray()[0]
    return row ? JSON.parse(row.entry) as SessionTreeEntry : undefined
  }

  async findEntries<TType extends SessionTreeEntry['type']>(type: TType): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.storage.sql.exec<EntryRow>(
      'SELECT seq, id, type, entry FROM pi_session_entries WHERE type = ? ORDER BY seq',
      type,
    ).toArray().map((row) => JSON.parse(row.entry) as Extract<SessionTreeEntry, { type: TType }>)
  }

  async getLabel(id: string): Promise<string | undefined> {
    const labels = await this.findEntries('label')
    for (let index = labels.length - 1; index >= 0; index--) {
      if (labels[index].targetId === id) return labels[index].label?.trim() || undefined
    }
  }

  async getSessionName(): Promise<string | undefined> {
    const names = await this.findEntries('session_info')
    return names.at(-1)?.name?.trim() || undefined
  }

  async getSessionStats(): Promise<SessionStats> {
    const stats: SessionStats = { messageCount: 0, cachedTokens: 0, uncachedTokens: 0, totalTokens: 0, costTotal: 0 }
    for (const entry of await this.getEntries()) {
      if (entry.type === 'message') stats.messageCount++
      const usage = usageFor(entry)
      if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number' ||
          typeof usage.cacheRead !== 'number' || typeof usage.cacheWrite !== 'number' ||
          typeof usage.cost?.total !== 'number') continue
      stats.cachedTokens += usage.cacheRead
      stats.uncachedTokens += usage.input + usage.cacheWrite
      stats.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite
      stats.costTotal += usage.cost.total
    }
    return stats
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return []
    const path: SessionTreeEntry[] = []
    let stopAtEntryId: string | null = null
    let current = await this.getEntry(leafId)
    if (!current) throw new SessionError('not_found', `Entry ${leafId} not found`)
    while (current) {
      path.unshift(current)
      if (stopAtEntryId !== null && current.id === stopAtEntryId) break
      if (current.type === 'compaction') {
        if (current.retainedTail) break
        stopAtEntryId = current.firstKeptEntryId ?? null
      }
      if (!current.parentId) break
      const parentId: string = current.parentId
      current = await this.getEntry(parentId)
      if (!current) throw new SessionError('invalid_session', `Entry ${parentId} not found`)
    }
    return path
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return []
    const path: SessionTreeEntry[] = []
    let current = await this.getEntry(leafId)
    if (!current) throw new SessionError('not_found', `Entry ${leafId} not found`)
    while (current) {
      path.unshift(current)
      if (!current.parentId) break
      const parentId: string = current.parentId
      current = await this.getEntry(parentId)
      if (!current) throw new SessionError('invalid_session', `Entry ${parentId} not found`)
    }
    return path
  }

  async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
    const after = options?.afterEntrySeq ?? 0
    const limit = options?.limit
    const rows = limit === undefined
      ? this.storage.sql.exec<EntryRow>('SELECT seq, id, type, entry FROM pi_session_entries WHERE seq > ? ORDER BY seq', after)
      : this.storage.sql.exec<EntryRow>('SELECT seq, id, type, entry FROM pi_session_entries WHERE seq > ? ORDER BY seq LIMIT ?', after, limit)
    return rows.toArray().map((row) => JSON.parse(row.entry) as SessionTreeEntry)
  }

  getEntriesWithSeq(): Array<{ seq: number; entry: SessionTreeEntry }> {
    return this.storage.sql.exec<EntryRow>(
      'SELECT seq, id, type, entry FROM pi_session_entries ORDER BY seq',
    ).toArray().map((row) => ({ seq: row.seq, entry: JSON.parse(row.entry) as SessionTreeEntry }))
  }

  replace(metadata: PiSessionMetadata, entries: SessionTreeEntry[]): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM pi_session_entries')
      this.storage.sql.exec('DELETE FROM pi_session_metadata')
      this.storage.sql.exec('DELETE FROM pi_session_outbox')
      this.storage.sql.exec("INSERT INTO pi_session_metadata(key, value) VALUES ('metadata', ?)", JSON.stringify(metadata))
      for (const entry of entries) {
        this.storage.sql.exec(
          'INSERT INTO pi_session_entries(id, type, entry) VALUES (?, ?, ?)',
          entry.id,
          entry.type,
          JSON.stringify(entry),
        )
      }
    })
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.storage.sql.exec<MetadataRow>('SELECT value FROM pi_session_settings WHERE key = ?', key).toArray()[0]
    return row ? JSON.parse(row.value) as T : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.storage.sql.exec(
      'INSERT INTO pi_session_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    )
  }

  getOutbox(): unknown[] {
    return this.storage.sql.exec<{ event: string }>(
      'SELECT event FROM pi_session_outbox ORDER BY seq',
    ).toArray().map((row) => JSON.parse(row.event) as unknown)
  }

  acknowledgeOutbox(eventIds: string[]): void {
    if (eventIds.length === 0) return
    this.storage.transactionSync(() => {
      for (const eventId of eventIds) {
        this.storage.sql.exec('DELETE FROM pi_session_outbox WHERE event_id = ?', eventId)
      }
    })
  }

  private enqueue(event: unknown): void {
    const eventId = (event as { eventId: string }).eventId
    this.storage.sql.exec('INSERT INTO pi_session_outbox(event_id, event) VALUES (?, ?)', eventId, JSON.stringify(event))
  }

  private countMessages(): number {
    return this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pi_session_entries WHERE type = 'message'",
    ).one().count
  }

  private hasEntry(id: string): boolean {
    return this.storage.sql.exec<{ found: number }>(
      'SELECT 1 AS found FROM pi_session_entries WHERE id = ? LIMIT 1',
      id,
    ).toArray().length !== 0
  }
}

function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null || !('content' in message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
}
