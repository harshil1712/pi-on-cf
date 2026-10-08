import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button, buttonVariants } from '@cloudflare/kumo/components/button'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowLeftIcon, GitBranchIcon, GitPullRequestIcon, PencilSimpleIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import { RenameSessionDialog } from '~/features/sessions/session-dialogs'
import { TopBar } from '~/features/shell/top-bar'
import { ChangesBrowser } from './components/changes-browser'
import { PromptComposer } from './components/prompt-composer'
import { TranscriptView } from './components/transcript-view'
import { WorkspaceBrowser } from './components/workspace-browser'
import { usePiSession } from './use-pi-session'

export function WorkspaceApp({ sessionId }: { sessionId: string }) {
  return <WorkspaceSession key={sessionId} sessionId={sessionId} />
}

const STATUS = {
  connecting: { label: 'Connecting', variant: 'neutral' },
  running: { label: 'Running', variant: 'warning' },
  ready: { label: 'Ready', variant: 'success' },
} as const

function WorkspaceSession({ sessionId }: { sessionId: string }) {
  const session = usePiSession(sessionId)
  const [filesOpen, setFilesOpen] = useState(true)
  const [renameOpen, setRenameOpen] = useState(false)
  const [panel, setPanel] = useState<'files' | 'changes'>('changes')
  const { task } = session
  const name = session.summary?.name || session.summary?.title || session.summary?.repo || `Untitled ${sessionId.slice(0, 8)}`
  const status = STATUS[!session.isReady ? 'connecting' : session.isRunning ? 'running' : 'ready']
  const chatView = session.mobileView === 'chat'

  return (
    <main className="flex h-dvh flex-col overflow-hidden">
      <TopBar
        actions={<>
          {task?.pullRequest && (
            <a href={task.pullRequest.url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              <GitPullRequestIcon size={14} />#{task.pullRequest.number}
            </a>
          )}
          <Button
            className="max-md:hidden"
            variant={filesOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilesOpen((open) => !open)}
            aria-pressed={filesOpen}
            icon={<SidebarSimpleIcon mirrored />}
          >
            {task
              ? <>Changes{session.changes.changes.length > 0 && ` · ${session.changes.changes.length}`}</>
              : <>Files{session.files.length > 0 && ` · ${session.files.length}`}</>}
          </Button>
        </>}
      >
        <Link to="/" className={buttonVariants({ variant: 'ghost', shape: 'square', size: 'base' })} aria-label="Back to sessions" title="All sessions">
          <ArrowLeftIcon size={18} />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1 className="sr-only">{name}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="group min-w-0 text-base font-semibold"
            onClick={() => setRenameOpen(true)}
            disabled={!session.summary}
            aria-label={name}
          >
            <span className="truncate">{name}</span>
            <PencilSimpleIcon size={13} aria-hidden="true" className="shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
          </Button>
          {task && (
            <span className="flex min-w-0 items-center gap-1 truncate text-xs text-kumo-subtle max-md:hidden" title={`${task.repo} · ${task.branch} from ${task.baseBranch}`}>
              {/* An unnamed session is titled with its repository, so the branch is enough here. */}
              <GitBranchIcon size={13} className="shrink-0" />{name === task.repo ? task.branch : `${task.repo} · ${task.branch}`}
            </span>
          )}
          <Badge variant={status.variant} appearance="dot" className="max-md:ring-0">
            <span className="max-md:sr-only">{status.label}</span>
            {session.queued > 0 && <span>· {session.queued} queued</span>}
          </Badge>
        </div>
      </TopBar>

      <section className="flex min-h-0 flex-1 max-md:flex-col">
        <nav className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-3 py-1.5 md:hidden" aria-label="Workspace view">
          <Tabs
            tabs={[
              { value: 'chat', label: 'Chat', render: <button id="chat-tab" aria-label="Chat" aria-controls="chat-panel" /> },
              { value: 'files', label: <>Files<span className="ml-1 text-kumo-subtle">{session.files.length}</span></>, render: <button id="files-tab" aria-label="Files" aria-controls="files-panel" /> },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'files')}
            activateOnFocus
          />
        </nav>
        <div id="chat-panel" className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !chatView && 'max-md:hidden')} role="tabpanel" aria-label="Chat" aria-labelledby="chat-tab">
          <TranscriptView activeTextId={session.activeTextId} entries={session.entries} isRunning={session.isRunning} onScroll={session.handleTranscriptScroll} onTryOperation={() => { session.setInput('Create /workspace/hello.ts with a Worker that returns “Hello from Pi”.'); document.getElementById('prompt')?.focus() }} transcriptRef={session.transcriptRef} />
          <div className="mx-auto w-full max-w-200 shrink-0 px-3 pt-2 pb-3 md:px-5 md:pb-4">
            {session.error && <Banner className="mb-2" variant="error" role="alert" description={session.error} />}
            <PromptComposer input={session.input} isReady={session.isReady} isRunning={session.isRunning} onAbort={() => void session.abort()} onInputChange={session.setInput} onSubmit={session.submit} repositories={session.listRepositories} models={session.models} model={session.model} onModelChange={(id) => void session.setModel(id)} />
          </div>
        </div>
        <div className={cn(
          'flex min-h-0 min-w-0 bg-kumo-base max-md:flex-1 md:w-[clamp(320px,34vw,480px)] md:border-l md:border-kumo-hairline',
          !filesOpen && 'md:hidden',
          chatView && 'max-md:hidden',
        )}>
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
