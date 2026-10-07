import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { ThemeToggle } from '../theme/theme-toggle'
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
  return session.name?.trim() || `Untitled ${session.id.slice(0, 8)}`
}

export function SessionCatalog() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const [name, setName] = useState('')
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
      await registry.reload()
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
    <main className="catalog">
      <header className="topbar">
        <span className="brand"><span className="brand-mark" aria-hidden="true">π</span>Pi</span>
        <div className="topbar-actions"><ThemeToggle /></div>
      </header>

      <div className="catalog-body">
        <div className="catalog-heading">
          <h1>Sessions</h1>
          <p>Each session keeps its own conversation and workspace files.</p>
        </div>

        <form onSubmit={create} className="new-session">
          <Input aria-label="Session name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name a new session (optional)" maxLength={120} />
          <Button type="submit" variant="primary" loading={busy === 'create'} disabled={Boolean(busy)} icon={<Plus size={16} />}>New session</Button>
        </form>

        {(registry.error || mutationError) && <Banner className="error-banner" variant="error" role="alert" description={registry.error || mutationError} />}

        <section aria-labelledby="session-list-title" aria-busy={registry.loading}>
          <h2 id="session-list-title" className="section-label">Recent{registry.sessions.length > 0 && <span>· {registry.sessions.length}</span>}</h2>
          {registry.loading && registry.sessions.length === 0 && <p className="catalog-loading">Loading…</p>}
          {!registry.loading && registry.sessions.length === 0 && <div className="catalog-empty">No sessions yet. Create one to get started.</div>}
          {registry.sessions.length > 0 && (
            <ul className="session-list">
              {registry.sessions.map((session) => (
                <li className="session-row" key={session.id}>
                  <Link className="session-link" to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                    <strong className={session.name?.trim() ? '' : 'untitled'}>{displayName(session)}</strong>
                    <span><time dateTime={session.updatedAt}>{relativeTime(session.updatedAt, now)}</time></span>
                  </Link>
                  <div className="session-actions" aria-label={`Actions for ${displayName(session)}`}>
                    <Button shape="square" size="sm" variant="ghost" aria-label="Rename session" title="Rename" disabled={Boolean(busy)} onClick={() => rename(session)} icon={<Pencil size={14} />} />
                    <Button shape="square" size="sm" variant="ghost" aria-label="Delete session" title="Delete" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Delete ${displayName(session)}? This cannot be undone.`)) void mutate(`delete-${session.id}`, () => registry.agent.stub.deleteSession(session.id)) }} icon={<Trash2 size={14} />} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}
