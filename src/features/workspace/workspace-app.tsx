import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { ArrowLeft, PanelRight, Pencil } from 'lucide-react'
import { ThemeToggle } from '../theme/theme-toggle'
import { PromptComposer } from './components/prompt-composer'
import { TranscriptView } from './components/transcript-view'
import { WorkspaceBrowser } from './components/workspace-browser'
import { usePiSession } from './use-pi-session'

export function WorkspaceApp({ sessionId }: { sessionId: string }) {
  return <WorkspaceSession key={sessionId} sessionId={sessionId} />
}

function WorkspaceSession({ sessionId }: { sessionId: string }) {
  const session = usePiSession(sessionId)
  const [filesOpen, setFilesOpen] = useState(true)
  const name = session.summary?.name || `Untitled ${sessionId.slice(0, 8)}`
  const status = !session.isReady ? 'connecting' : session.isRunning ? 'running' : 'ready'
  const statusLabel = status === 'connecting' ? 'Connecting' : status === 'running' ? 'Running' : 'Ready'

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link to="/" className="icon-link" aria-label="Back to sessions" title="All sessions"><ArrowLeft size={18} /></Link>
        <div className="session-heading">
          <h1 className="sr-only">{name}</h1>
          <button className="session-name" onClick={() => void session.rename()} disabled={!session.summary} title="Rename session" aria-label={name}>
            <span>{name}</span><Pencil size={13} aria-hidden="true" />
          </button>
          <span className={`status status-${status}`} title={statusLabel}>
            <span className="status-dot" aria-hidden="true" />
            <span className="status-label">{statusLabel}</span>
            {session.queued > 0 && <span>· {session.queued} queued</span>}
          </span>
        </div>
        <div className="topbar-actions">
          <ThemeToggle />
          <Button
            className="files-toggle"
            variant={filesOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilesOpen((open) => !open)}
            aria-pressed={filesOpen}
            icon={<PanelRight size={14} />}
          >
            Files{session.files.length > 0 && ` · ${session.files.length}`}
          </Button>
        </div>
      </header>

      <section className="workbench">
        <nav className="mobile-switcher" aria-label="Workspace view">
          <Tabs
            tabs={[
              { value: 'chat', label: 'Chat', render: <button id="chat-tab" aria-label="Chat" aria-controls="chat-panel" /> },
              { value: 'files', label: <>Files<span>{session.files.length}</span></>, render: <button id="files-tab" aria-label="Files" aria-controls="files-panel" /> },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'files')}
            activateOnFocus
          />
        </nav>

        <div id="chat-panel" className={`console-panel ${session.mobileView !== 'chat' ? 'mobile-hidden' : ''}`} role="tabpanel" aria-label="Chat" aria-labelledby="chat-tab">
          <TranscriptView activeTextId={session.activeTextId} entries={session.entries} isRunning={session.isRunning} onScroll={session.handleTranscriptScroll} onTryOperation={() => { session.setInput('Create /workspace/hello.ts with a Worker that returns “Hello from Pi”.'); document.getElementById('prompt')?.focus() }} transcriptRef={session.transcriptRef} />
          <div className="composer">
            {session.error && <Banner className="error-banner" variant="error" role="alert" description={session.error} />}
            <PromptComposer input={session.input} isReady={session.isReady} isRunning={session.isRunning} onAbort={() => void session.abort()} onInputChange={session.setInput} onSubmit={session.submit} />
          </div>
        </div>

        <div className={`right-panel ${filesOpen ? '' : 'panel-closed'} ${session.mobileView === 'chat' ? 'mobile-hidden' : ''}`}>
          <WorkspaceBrowser canDownload={session.canDownload} fileContent={session.fileContent} fileError={session.fileError} files={session.files} filesError={session.filesError} filesLoading={session.filesLoading} onDownload={session.downloadSelectedFile} onRefresh={() => void session.refreshFiles()} onSelectPath={session.setSelectedPath} selectedPath={session.selectedPath} />
        </div>
      </section>
    </main>
  )
}
