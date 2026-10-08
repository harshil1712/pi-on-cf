import { useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo/components/button'
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown'
import { Sidebar, useSidebar } from '@cloudflare/kumo/components/sidebar'
import { useKumoToastManager } from '@cloudflare/kumo/components/toast'
import { cn } from '@cloudflare/kumo/utils'
import { ChatsCircleIcon, DotsThreeIcon, GitPullRequestIcon, NotePencilIcon, PencilSimpleIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { PiMark } from './pi-mark'
import { ThemeToggle } from './theme-toggle'
import type { SessionSummary } from '~/contract'
import { DeleteSessionDialog, RenameSessionDialog } from './session-dialogs'
import { displayName, useSessionRegistry } from '~/hooks/use-session-registry'

const DAY = 24 * 60 * 60 * 1000

/** Sessions by when they were last active, newest first, as the registry lists them. */
function groupByRecency(sessions: SessionSummary[], now: number) {
  const today = new Date(now).setHours(0, 0, 0, 0)
  const groups: { label: string; sessions: SessionSummary[] }[] = []
  for (const session of sessions) {
    const at = Date.parse(session.updatedAt)
    const label = at >= today ? 'Today' : at >= today - DAY ? 'Yesterday' : at >= today - 6 * DAY ? 'Previous 7 days' : 'Older'
    const group = groups.at(-1)
    if (group?.label === label) group.sessions.push(session)
    else groups.push({ label, sessions: [session] })
  }
  return groups
}

/** A pulsing dot while pi runs, in the colour of the session page's Running badge, a warning after a failed run, nothing when idle. */
function StatusMarker({ status }: Pick<SessionSummary, 'status'>) {
  if (status === 'running') {
    return (
      <span className="flex size-3 shrink-0 items-center justify-center" title="Running">
        <span aria-hidden className="size-2 rounded-full bg-kumo-warning motion-safe:animate-pulse" />
        <span className="sr-only">(running)</span>
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex shrink-0 items-center text-kumo-danger" title="Last run failed">
        <WarningCircleIcon aria-hidden size={13} />
        <span className="sr-only">(last run failed)</span>
      </span>
    )
  }
  return null
}

export function SessionSidebar() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { isMobile, setOpenMobile } = useSidebar()
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  // The target outlives `open` so the dialog keeps its text while it animates closed.
  const [dialog, setDialog] = useState<{ action: 'rename' | 'delete'; session: SessionSummary; open: boolean } | null>(null)
  const closeDialog = (open: boolean) => { if (!open) setDialog((current) => current && { ...current, open: false }) }
  const groups = groupByRecency(registry.sessions, Date.now())
  // On a phone the sidebar is a sheet over the page; picking a destination closes it.
  const closeOnMobile = () => { if (isMobile) setOpenMobile(false) }

  async function act(operation: () => Promise<unknown>) {
    try {
      await operation()
    } catch (caught) {
      toasts.add({ variant: 'error', title: 'Something went wrong', description: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  return (
    <>
      <Sidebar aria-label="Sessions">
        <Sidebar.Header className="gap-0.5 pr-2 pl-4">
          <span className="mr-auto flex items-center gap-2 font-semibold"><PiMark />Pi</span>
          <Button
            shape="square"
            size="sm"
            variant="ghost"
            aria-label="New session"
            title="New session"
            icon={<NotePencilIcon size={17} />}
            onClick={() => { closeOnMobile(); void navigate({ to: '/' }) }}
          />
          {!isMobile && <Sidebar.Trigger aria-label="Hide sessions" title="Hide sessions" />}
        </Sidebar.Header>
        <Sidebar.Content>
          {registry.loading && registry.sessions.length === 0 ? (
            <Sidebar.Loading label="Loading sessions" />
          ) : registry.sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-kumo-subtle">
              <ChatsCircleIcon size={28} className="text-kumo-inactive" />
              Sessions you start appear here.
            </div>
          ) : groups.map((group) => (
            <Sidebar.Group key={group.label}>
              <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {group.sessions.map((session) => (
                  <Sidebar.MenuItem key={session.id} className="group/session relative">
                    <Sidebar.MenuButton
                      href={`/sessions/${session.id}`}
                      active={session.id === sessionId}
                      aria-current={session.id === sessionId ? 'page' : undefined}
                      onClick={closeOnMobile}
                      className="pr-8"
                    >
                      <span className="flex min-w-0 flex-1 flex-col py-0.5">
                        <span className="truncate">{displayName(session)}</span>
                        {session.repo && session.repo !== displayName(session) && (
                          <span className="truncate text-xs text-kumo-subtle">{session.repo}</span>
                        )}
                      </span>
                      <StatusMarker status={session.status} />
                      {session.pullRequest && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-kumo-subtle" title={`Pull request #${session.pullRequest.number}`}>
                          <GitPullRequestIcon size={12} />{session.pullRequest.number}
                        </span>
                      )}
                    </Sidebar.MenuButton>
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={(
                          <Button
                            shape="square"
                            size="xs"
                            variant="ghost"
                            aria-label={`Actions for ${displayName(session)}`}
                            icon={<DotsThreeIcon size={16} weight="bold" />}
                            className={cn(
                              'absolute top-1/2 right-1 -translate-y-1/2 transition-opacity',
                              'md:opacity-0 md:group-hover/session:opacity-100 md:group-focus-within/session:opacity-100 md:data-popup-open:opacity-100',
                            )}
                          />
                        )}
                      />
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setDialog({ action: 'rename', session, open: true })}>Rename</DropdownMenu.Item>
                        <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => setDialog({ action: 'delete', session, open: true })}>Delete</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  </Sidebar.MenuItem>
                ))}
              </Sidebar.Menu>
            </Sidebar.Group>
          ))}
        </Sidebar.Content>
        <Sidebar.Footer className="flex items-center justify-between px-3 py-2">
          <span className="text-xs text-kumo-subtle">Pi on Cloudflare</span>
          <ThemeToggle />
        </Sidebar.Footer>
      </Sidebar>
      {dialog && (
        <>
          <RenameSessionDialog
            name={dialog.session.name}
            open={dialog.open && dialog.action === 'rename'}
            onOpenChange={closeDialog}
            onRename={(name) => void act(() => registry.agent.stub.renameSession(dialog.session.id, name))}
          />
          <DeleteSessionDialog
            name={displayName(dialog.session)}
            open={dialog.open && dialog.action === 'delete'}
            onOpenChange={closeDialog}
            onDelete={() => void act(async () => {
              const { id } = dialog.session
              await registry.agent.stub.deleteSession(id)
              // The open session is gone, so go home rather than to a dead page.
              if (id === sessionId) await navigate({ to: '/' })
            })}
          />
        </>
      )}
    </>
  )
}
