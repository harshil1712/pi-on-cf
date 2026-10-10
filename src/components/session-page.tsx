import { useMemo, useState } from 'react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button, buttonVariants } from '@cloudflare/kumo/components/button'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { cn } from '@cloudflare/kumo/utils'
import { GitBranchIcon, GitPullRequestIcon, GlobeIcon, PencilSimpleIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import { BrowserViewPanel } from './browser-view'
import { RenameSessionDialog } from './session-dialogs'
import { TopBar } from './top-bar'
import { ChangesBrowser } from './changes-browser'
import { PromptComposer } from './prompt-composer'
import { TranscriptView } from './transcript-view'
import { WorkspaceBrowser } from './workspace-browser'
import { useBrowserView } from '~/hooks/use-browser-view'
import { usePiSession } from '~/hooks/use-pi-session'

export function SessionPage({ sessionId }: { sessionId: string }) {
  return <SessionView key={sessionId} sessionId={sessionId} />
}

const STATUS = {
  connecting: { label: 'Connecting', variant: 'neutral' },
  running: { label: 'Running', variant: 'warning' },
  ready: { label: 'Ready', variant: 'success' },
} as const

function SessionView({ sessionId }: { sessionId: string }) {
  const session = usePiSession(sessionId)
  const [filesOpen, setFilesOpen] = useState(true)
  const [renameOpen, setRenameOpen] = useState(false)
  const [panel, setPanel] = useState<'files' | 'changes' | 'browser'>('changes')
  const { task } = session
  // Finished browser calls: each one lists Pi's tabs again while the Browser view is up.
  const browserRuns = useMemo(() => session.entries.filter((entry) => entry.type === 'tool' && entry.name === 'browser' && entry.status !== 'running').length, [session.entries])
  const browser = useBrowserView(session.browserLiveView, { isReady: session.isReady, active: panel === 'browser', browserRuns })
  // What the Workspace panel shows: Changes only with a task, Browser only with a browser.
  const view = panel === 'browser' && browser.available ? 'browser' : task && panel === 'changes' ? 'changes' : 'files'
  const showPanel = (next: 'files' | 'changes' | 'browser') => {
    setPanel(next)
    // Live View URLs only connect for about five minutes, so opening the view mints fresh ones.
    if (next === 'browser') void browser.refresh({ reconnect: true })
  }
  const openBrowser = () => {
    showPanel('browser')
    setFilesOpen(true)
    session.setMobileView('workspace')
  }
  const name = session.summary?.name || session.summary?.title || session.summary?.repo || `Untitled ${sessionId.slice(0, 8)}`
  const status = STATUS[!session.isReady ? 'connecting' : session.isRunning ? 'running' : 'ready']
  const chatView = session.mobileView === 'chat'
  const changeCount = task ? session.changes.changes.length : 0

  return (
    // Chat and Workspace sit side by side only when the page itself is wide enough, not the window:
    // the sidebar takes 260px from a tablet. Container queries (`@4xl:`, 56rem) measure this element.
    <main className="@container flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar
        actions={<>
          {browser.available && (
            <Button variant="ghost" size="sm" shape="square" className="size-8.5 @4xl:size-6.5" icon={<GlobeIcon />} onClick={openBrowser} aria-pressed={view === 'browser' && filesOpen} aria-label="Pi's browser" title="Pi's browser" />
          )}
          {task?.pullRequest && (
            <a href={task.pullRequest.url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              <GitPullRequestIcon size={14} />#{task.pullRequest.number}
            </a>
          )}
          <Button
            className="hidden @4xl:flex"
            variant={filesOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilesOpen((open) => !open)}
            aria-pressed={filesOpen}
            icon={<SidebarSimpleIcon mirrored />}
          >
            Workspace<ChangesDot count={changeCount} />
          </Button>
        </>}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1 className="sr-only">{name}</h1>
          <Button
            variant="ghost"
            size="sm"
            // Kumo's buttons are w-max and shrink-0; a long title must shrink and truncate instead of pushing the status off a phone.
            className="group w-auto min-w-0 shrink text-base font-semibold"
            onClick={() => setRenameOpen(true)}
            disabled={!session.summary}
            aria-label={name}
          >
            <span className="truncate">{name}</span>
            <PencilSimpleIcon size={13} aria-hidden="true" className="shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
          </Button>
          {task && (
            <span className="hidden min-w-0 items-center gap-1 truncate text-xs text-kumo-subtle @3xl:flex" title={`${task.repo} · ${task.branch} from ${task.baseBranch}`}>
              {/* An unnamed session is titled with its repository, so the branch is enough here. */}
              <GitBranchIcon size={13} className="shrink-0" />{name === task.repo ? task.branch : `${task.repo} · ${task.branch}`}
            </span>
          )}
          <Badge variant={status.variant} appearance="dot" className="@max-3xl:ring-0">
            {/* In a narrow page the badge is just its dot; the label stays for screen readers. */}
            <span className="sr-only @3xl:not-sr-only">{status.label}</span>
            {session.queued > 0 && <span>· {session.queued} queued</span>}
          </Badge>
        </div>
      </TopBar>

      {/* Narrow: Chat and Workspace are tabs; wide: they sit side by side. */}
      <section className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
        <nav className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-3 py-1.5 @4xl:hidden" aria-label="Session view">
          <Tabs
            tabs={[
              { value: 'chat', label: 'Chat', render: <button id="chat-tab" aria-label="Chat" aria-controls="chat-panel" /> },
              {
                value: 'workspace',
                // Pi's changes wait behind this tab, so a dot points them out.
                label: <>Workspace<ChangesDot count={changeCount} /></>,
                render: <button id="workspace-tab" aria-label="Workspace" aria-controls="workspace-panel" />,
              },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'workspace')}
            activateOnFocus
          />
        </nav>
        <div id="chat-panel" className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !chatView && 'hidden @4xl:flex')} role="tabpanel" aria-label="Chat" aria-labelledby="chat-tab">
          <TranscriptView activeTextId={session.activeTextId} entries={session.entries} isRunning={session.isRunning} onScroll={session.handleTranscriptScroll} onTryOperation={() => { session.setInput('Create /workspace/hello.ts with a Worker that returns “Hello from Pi”.'); document.getElementById('prompt')?.focus() }} transcriptRef={session.transcriptRef} />
          <div className="mx-auto w-full max-w-200 shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] @3xl:px-5 @3xl:pb-4">
            {session.error && <Banner className="mb-2" variant="error" role="alert" description={session.error} />}
            <PromptComposer input={session.input} isReady={session.isReady} isRunning={session.isRunning} onAbort={() => void session.abort()} onInputChange={session.setInput} onSubmit={session.submit} repositories={session.listRepositories} models={session.models} model={session.model} onModelChange={(id) => void session.setModel(id)} />
          </div>
        </div>
        <div
          id="workspace-panel"
          role="tabpanel"
          aria-label="Workspace"
          aria-labelledby="workspace-tab"
          className={cn(
            // One width for every view, wide enough for Pi's desktop-sized browser pages.
            'flex min-h-0 min-w-0 flex-1 bg-kumo-base @4xl:w-[clamp(320px,45cqw,720px)] @4xl:flex-none @4xl:border-l @4xl:border-kumo-hairline',
            chatView && 'hidden @4xl:flex',
            // Last: class merging keeps the last display class, so the toggle must win over `@4xl:flex`.
            !filesOpen && '@4xl:hidden',
          )}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {(task || browser.available) && (
              <div className="shrink-0 border-b border-kumo-hairline px-3 py-1.5">
                <Tabs
                  size="sm"
                  variant="segmented"
                  tabs={[
                    ...task ? [{ value: 'changes', label: <>Changes<span className="ml-1 text-kumo-subtle">{session.changes.changes.length}</span></> }] : [],
                    { value: 'files', label: <>Files<span className="ml-1 text-kumo-subtle">{session.files.length}</span></> },
                    ...browser.available ? [{ value: 'browser', label: 'Browser' }] : [],
                  ]}
                  value={view}
                  onValueChange={(value) => showPanel(value as 'files' | 'changes' | 'browser')}
                />
              </div>
            )}
            {view === 'browser' ? (
              <BrowserViewPanel browser={browser} />
            ) : view === 'changes' && task ? (
              <ChangesBrowser changes={session.changes.changes} diff={session.changes.diff} diffError={session.changes.diffError} error={session.changes.error} loading={session.changes.loading} onRefresh={() => void session.changes.refresh()} onSelectPath={session.changes.setSelectedPath} selectedPath={session.changes.selectedPath} task={task} />
            ) : (
              <WorkspaceBrowser canDownload={session.canDownload} fileContent={session.fileContent} fileError={session.fileError} files={session.files} filesError={session.filesError} filesLoading={session.filesLoading} onDownload={session.downloadSelectedFile} onRefresh={() => void session.refreshFiles()} onSelectPath={session.setSelectedPath} selectedPath={session.selectedPath} />
            )}
          </div>
        </div>
      </section>

      <RenameSessionDialog name={session.summary?.name} open={renameOpen} onOpenChange={setRenameOpen} onRename={(next) => void session.rename(next)} />
    </main>
  )
}

/** A dot that says Pi has changes waiting in the workspace, with the count for screen readers. */
function ChangesDot({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <>
      <span aria-hidden className="ml-1.5 inline-block size-1.5 rounded-full bg-kumo-warning" />
      <span className="sr-only">, {count} {count === 1 ? 'change' : 'changes'}</span>
    </>
  )
}
