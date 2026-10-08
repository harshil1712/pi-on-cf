import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Input } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Text } from '@cloudflare/kumo/components/text'
import { cn } from '@cloudflare/kumo/utils'
import { ChatsCircleIcon, GitPullRequestIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { PiMark, TopBar } from '~/features/shell/top-bar'
import type { SessionSummary } from '~/shared/pi-contract'
import { DeleteSessionDialog, RenameSessionDialog } from './session-dialogs'
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
  return session.name?.trim() || session.repo || `Untitled ${session.id.slice(0, 8)}`
}

export function SessionCatalog() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // The target outlives `open` so the dialog keeps its text while it animates closed.
  const [dialog, setDialog] = useState<{ action: 'rename' | 'delete'; session: SessionSummary; open: boolean } | null>(null)
  const closeDialog = (open: boolean) => { if (!open) setDialog((current) => current && { ...current, open: false }) }

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

  return (
    <main className="flex min-h-full flex-col">
      <TopBar>
        <span className="flex items-center gap-2 font-semibold"><PiMark />Pi</span>
      </TopBar>
      <div className="mx-auto w-full max-w-180 px-4 pt-7 pb-12 md:px-5 md:pt-12 md:pb-16">
        <div className="mb-6 flex flex-col gap-1">
          <Text variant="heading" size="lg" as="h1">Sessions</Text>
          <Text variant="secondary">Each session keeps its own conversation and workspace. Mention a GitHub repository with @ in the chat, and Pi clones it when it needs the code, to answer questions or to work on a branch and open a pull request.</Text>
        </div>
        <form onSubmit={create} className="mb-8 flex flex-col gap-2 md:flex-row">
          <div className="min-w-0 md:flex-1">
            <Input className="w-full" aria-label="Session name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name a new session (optional)" maxLength={120} />
          </div>
          <Button type="submit" variant="primary" loading={busy === 'create'} disabled={Boolean(busy)} icon={PlusIcon}>New session</Button>
        </form>
        {(registry.error || mutationError) && <Banner className="mb-3" variant="error" role="alert" description={registry.error || mutationError} />}
        <section aria-labelledby="session-list-title" aria-busy={registry.loading}>
          <h2 id="session-list-title" className="mb-2 flex items-center gap-1.5 text-xs font-medium text-kumo-subtle">
            Recent{registry.sessions.length > 0 && <span>· {registry.sessions.length}</span>}
          </h2>
          {registry.loading && registry.sessions.length === 0 && (
            <div className="flex items-center gap-2 p-4 text-kumo-subtle"><Loader size="sm" />Loading…</div>
          )}
          {!registry.loading && registry.sessions.length === 0 && (
            <Empty size="sm" icon={<ChatsCircleIcon size={32} className="text-kumo-inactive" />} title="No sessions yet" description="Create one to get started." />
          )}
          {registry.sessions.length > 0 && (
            <LayerCard render={<ul />} className="divide-y divide-kumo-hairline overflow-hidden p-0">
              {registry.sessions.map((session) => (
                <li className="group flex items-center gap-2 pr-2 hover:bg-kumo-tint focus-within:bg-kumo-tint" key={session.id}>
                  <Link
                    className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 pr-2 pl-4 no-underline md:flex-row md:items-baseline md:justify-between md:gap-4"
                    to="/sessions/$sessionId"
                    params={{ sessionId: session.id }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className={cn('truncate', session.name?.trim() || session.repo ? 'font-medium' : 'text-kumo-subtle')}>{displayName(session)}</span>
                      {session.repo && <span className="truncate text-xs text-kumo-subtle">{session.repo} · {session.branch}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-kumo-subtle">
                      {session.pullRequest && <span className="flex items-center gap-0.5"><GitPullRequestIcon size={12} />#{session.pullRequest.number}</span>}
                      <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt, now)}</time>
                    </span>
                  </Link>
                  <div className="flex gap-0.5 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100" aria-label={`Actions for ${displayName(session)}`}>
                    <Button shape="square" size="sm" variant="ghost" aria-label="Rename session" disabled={Boolean(busy)} onClick={() => setDialog({ action: 'rename', session, open: true })} icon={PencilSimpleIcon} />
                    <Button shape="square" size="sm" variant="ghost" aria-label="Delete session" disabled={Boolean(busy)} onClick={() => setDialog({ action: 'delete', session, open: true })} icon={TrashIcon} />
                  </div>
                </li>
              ))}
            </LayerCard>
          )}
        </section>
      </div>
      {dialog && (
        <>
          <RenameSessionDialog
            name={dialog.session.name}
            open={dialog.open && dialog.action === 'rename'}
            onOpenChange={closeDialog}
            onRename={(nextName) => {
              const { id } = dialog.session
              void mutate(`rename-${id}`, async () => { await registry.agent.stub.renameSession(id, nextName) })
            }}
          />
          <DeleteSessionDialog
            name={displayName(dialog.session)}
            open={dialog.open && dialog.action === 'delete'}
            onOpenChange={closeDialog}
            onDelete={() => {
              const { id } = dialog.session
              void mutate(`delete-${id}`, () => registry.agent.stub.deleteSession(id))
            }}
          />
        </>
      )}
    </main>
  )
}
