import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Copy, GitFork, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { SessionSummary } from '../../shared/pi-contract'
import { useSessionRegistry } from './use-session-registry'

function relativeTime(value: string, now: number) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

function displayName(session: SessionSummary) {
  return session.name?.trim() || `UNTITLED / ${session.id.slice(0, 8)}`
}

export function SessionCatalog() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function mutate(key: string, operation: () => Promise<void>) {
    setBusy(key)
    setMutationError('')
    try {
      await operation()
      await registry.reload(query)
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy('')
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy('create')
    setMutationError('')
    try {
      const session = await registry.agent.stub.createSession({ name: name.trim() || undefined })
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught))
      setBusy('')
    }
  }

  function rename(session: SessionSummary) {
    const nextName = window.prompt('Session name', session.name ?? '')
    if (nextName === null) return
    void mutate(`rename-${session.id}`, async () => {
      await registry.agent.stub.renameSession(session.id, nextName.trim() || undefined)
    })
  }

  return (
    <main className="catalog-shell">
      <header className="catalog-masthead">
        <div className="brand-lockup">
          <div className="brand-mark">π</div>
          <div><p className="eyebrow">DURABLE AGENT SESSION REGISTRY</p><h1>PI SESSIONS</h1></div>
        </div>
        <div className="catalog-counter"><strong>{registry.sessions.length.toString().padStart(2, '0')}</strong><span>ACTIVE THREADS</span></div>
      </header>

      <section className="catalog-grid">
        <aside className="catalog-control">
          <p className="panel-index">01 / INITIALIZE</p>
          <h2>START A NEW<br />WORKING LINE</h2>
          <form onSubmit={create} className="create-session-form">
            <label htmlFor="session-name">SESSION NAME <span>OPTIONAL</span></label>
            <input id="session-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. EDGE CACHE PROTOTYPE" maxLength={120} />
            <Button type="submit" disabled={Boolean(busy)} className="catalog-primary">
              <Plus size={18} /> {busy === 'create' ? 'INITIALIZING' : 'CREATE SESSION'}
            </Button>
          </form>
          <div className="registry-note"><span>REGISTRY</span><strong>SINGLETON / ONLINE</strong><p>Each session is an isolated Durable Object with its own history and workspace.</p></div>
        </aside>

        <div className="catalog-list-area">
          <search>
          <form className="catalog-search" onSubmit={(event) => { event.preventDefault(); void registry.reload(query) }}>
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="session-search">Search sessions and messages</label>
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEARCH NAMES + TRANSCRIPTS / re: PATTERN" />
            <Button type="submit" variant="outline" disabled={registry.loading}>SCAN</Button>
          </form>
          </search>

          {(registry.error || mutationError) && <Banner className="error-banner" variant="error" role="alert" description={registry.error || mutationError} />}

          {query.trim() && registry.results.length > 0 && (
            <section className="search-results" aria-labelledby="search-results-title">
              <h2 id="search-results-title">MESSAGE MATCHES / {registry.results.length}</h2>
              {registry.results.map(({ session, matches }) => (
                <article key={session.id}>
                  <Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>{displayName(session)}</Link>
                  {matches.slice(0, 3).map((match) => <div className="search-hit" key={match.entryId}><span>{match.role}</span><p>{match.text}</p>{match.role === 'user' && <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void mutate(`fork-${match.entryId}`, async () => { const forked = await registry.agent.stub.forkSession({ sourceSessionId: session.id, entryId: match.entryId, name: `${session.name || 'Untitled'} fork` }); await navigate({ to: '/sessions/$sessionId', params: { sessionId: forked.id } }) })}><GitFork size={13} /> FORK HERE</Button>}</div>)}
                </article>
              ))}
            </section>
          )}

          <section className="session-list" aria-labelledby="session-list-title" aria-busy={registry.loading}>
            <div className="session-list-heading"><h2 id="session-list-title">RECENT SESSIONS</h2><span>UPDATED / DESCENDING</span></div>
            {!registry.loading && registry.sessions.length === 0 && <div className="catalog-empty"><strong>NO SESSION RECORDS</strong><span>Create the first durable working line.</span></div>}
            {registry.sessions.map((session, index) => (
              <article className="session-row" key={session.id}>
                <span className="session-number">{String(index + 1).padStart(2, '0')}</span>
                <Link className="session-main-link" to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                  <strong>{displayName(session)}</strong>
                  <span>{session.messageCount} MSG / {session.lineage.type.toUpperCase()} / <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt, now)}</time></span>
                </Link>
                <div className="session-actions" aria-label={`Actions for ${displayName(session)}`}>
                  <Button shape="square" size="sm" variant="ghost" aria-label="Rename session" title="Rename session" disabled={Boolean(busy)} onClick={() => rename(session)} icon={<Pencil size={15} />} />
                  <Button shape="square" size="sm" variant="ghost" aria-label="Clone session" title="Clone session" disabled={Boolean(busy)} onClick={() => void mutate(`clone-${session.id}`, async () => { const clone = await registry.agent.stub.cloneSession({ sourceSessionId: session.id, name: `${session.name || 'Untitled'} copy` }); await navigate({ to: '/sessions/$sessionId', params: { sessionId: clone.id } }) })} icon={<Copy size={15} />} />
                  <Button shape="square" size="sm" variant="ghost" aria-label="Delete session" title="Delete session" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Delete ${displayName(session)}? This cannot be undone.`)) void mutate(`delete-${session.id}`, () => registry.agent.stub.deleteSession(session.id)) }} icon={<Trash2 size={15} />} />
                </div>
              </article>
            ))}
          </section>
        </div>
      </section>
    </main>
  )
}
