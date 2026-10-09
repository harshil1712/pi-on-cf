import { useEffect, useState } from 'react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button, buttonVariants } from '@cloudflare/kumo/components/button'
import { Popover } from '@cloudflare/kumo/components/popover'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowsOutSimpleIcon, GitBranchIcon, GitPullRequestIcon, GlobeIcon, PencilSimpleIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import type { BrowserTabView } from '~/contract'
import { RenameSessionDialog } from './session-dialogs'
import { TopBar } from './top-bar'
import { ChangesBrowser } from './changes-browser'
import { PromptComposer } from './prompt-composer'
import { TranscriptView } from './transcript-view'
import { WorkspaceBrowser } from './workspace-browser'
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
  const [panel, setPanel] = useState<'files' | 'changes'>('changes')
  // The browser's Live View tabs: the probe says whether the deployment runs a browser at all,
  // each click mints fresh URLs because they only watch for about five minutes.
  const [browserTabs, setBrowserTabs] = useState<BrowserTabView[] | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const { browserLiveView, isReady } = session
  useEffect(() => {
    if (!isReady) return
    void browserLiveView().then((tabs) => { if (tabs) setBrowserTabs(tabs) }).catch(() => {})
  }, [isReady, browserLiveView])
  const openBrowser = async () => {
    setBrowserTabs((await browserLiveView()) ?? browserTabs)
    setBrowserOpen(true)
  }
  const { task } = session
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
          {browserTabs !== null && (
            <Popover open={browserOpen} onOpenChange={setBrowserOpen}>
              <Popover.Trigger render={
                <Button variant="ghost" size="sm" icon={<GlobeIcon />} onClick={() => void openBrowser()} aria-label="Pi's browser" title="Pi's browser" />
              } />
              <Popover.Content side="bottom" align="end" className="w-80 p-2">
                <span className="block px-2 pt-1 pb-1.5 text-xs font-medium text-kumo-subtle">Pi's browser tabs</span>
                {browserTabs.length === 0 ? (
                  <p className="px-2 pb-1 text-sm text-kumo-subtle">No tab is open yet. Ask Pi to look at a page with its browser tool, then watch here.</p>
                ) : (
                  <ul>
                    {browserTabs.map((tab, index) => (
                      <li key={index}>
                        <a href={tab.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-kumo-tint">
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{tab.title || 'Untitled'}</span>
                            <span className="block truncate text-xs text-kumo-subtle">{tab.pageUrl}</span>
                          </span>
                          <ArrowsOutSimpleIcon size={14} className="mt-1 shrink-0 text-kumo-subtle" aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <span className="block px-2 pt-1.5 text-xs text-kumo-subtle">Watch live for about five minutes; ask again after that.</span>
              </Popover.Content>
            </Popover>
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
            'flex min-h-0 min-w-0 flex-1 bg-kumo-base @4xl:w-[clamp(320px,36cqw,480px)] @4xl:flex-none @4xl:border-l @4xl:border-kumo-hairline',
            !filesOpen && '@4xl:hidden',
            chatView && 'hidden @4xl:flex',
          )}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {task && (
              <div className="shrink-0 border-b border-kumo-hairline px-3 py-1.5">
                <Tabs
                  size="sm"
                  variant="segmented"
                  tabs={[
                    { value: 'changes', label: <>Changes<span className="ml-1 text-kumo-subtle">{session.changes.changes.length}</span></> },
                    { value: 'files', label: <>Files<span className="ml-1 text-kumo-subtle">{session.files.length}</span></> },
                  ]}
                  value={panel}
                  onValueChange={(value) => setPanel(value as 'files' | 'changes')}
                />
              </div>
            )}
            {task && panel === 'changes' ? (
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
