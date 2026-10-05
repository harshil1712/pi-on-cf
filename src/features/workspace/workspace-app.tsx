import { Link } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { ArrowLeft } from 'lucide-react'
import { PromptComposer } from './components/prompt-composer'
import { TranscriptView } from './components/transcript-view'
import { WorkspaceBrowser } from './components/workspace-browser'
import { usePiSession } from './use-pi-session'

export function WorkspaceApp({ sessionId }: { sessionId: string }) {
  return <WorkspaceSession key={sessionId} sessionId={sessionId} />
}

function WorkspaceSession({ sessionId }: { sessionId: string }) {
  const session = usePiSession(sessionId)
  const messageCount = session.entries.filter((entry) => entry.type === 'message').length
  const name = session.summary?.name || `UNTITLED / ${sessionId.slice(0, 8)}`

  return (
    <main className="app-shell">
      <header className="masthead workspace-masthead">
        <div className="brand-lockup">
          <Link to="/" className="back-button" aria-label="Back to sessions"><ArrowLeft size={19} /></Link>
          <div className="brand-mark">π</div>
          <div className="session-title">
            <p className="eyebrow">SESSION / {sessionId}</p>
            <h1><button onClick={() => void session.rename()} disabled={!session.summary} title="Rename session">{name}</button></h1>
          </div>
        </div>
        <div className="runtime-status"><span className="status-light" />{session.isRunning ? 'PI RUNNING' : 'WORKER ONLINE'}{session.queued > 0 && ` / ${session.queued} QUEUED`}</div>
      </header>

      <section className="workbench">
        <nav className="mobile-switcher" aria-label="Workspace view">
          <Tabs
            tabs={[
              { value: 'chat', label: 'CHAT', render: <button id="chat-tab" aria-label="CHAT" aria-controls="chat-panel" /> },
              { value: 'files', label: <>FILES <span>{session.files.length}</span></>, render: <button id="files-tab" aria-label="FILES" aria-controls="files-panel" /> },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'files')}
            activateOnFocus className="mobile-tabs" listClassName="mobile-tabs-list" indicatorClassName="mobile-tabs-indicator"
          />
        </nav>

        <div id="chat-panel" className={`console-panel ${session.mobileView !== 'chat' ? 'mobile-hidden' : ''}`} role="tabpanel" aria-label="Chat" aria-labelledby="chat-tab">
          <div className="console-header"><span>ACTIVE / {name.toUpperCase()}</span><span>{messageCount.toString().padStart(3, '0')} MSG</span></div>
          <TranscriptView activeTextId={session.activeTextId} entries={session.entries} isRunning={session.isRunning} onScroll={session.handleTranscriptScroll} onTryOperation={() => session.setInput('Create /workspace/hello.ts with a Worker that returns “Hello from Pi”.')} transcriptRef={session.transcriptRef} />
          {session.error && <Banner className="error-banner" variant="error" role="alert" description={session.error} />}
          <PromptComposer input={session.input} isReady={session.isReady} isRunning={session.isRunning} onAbort={() => void session.abort()} onInputChange={session.setInput} onSubmit={session.submit} />
        </div>

        <div className={`right-panel ${session.mobileView === 'chat' ? 'mobile-hidden' : ''}`}>
          <WorkspaceBrowser canDownload={session.canDownload} fileContent={session.fileContent} fileError={session.fileError} files={session.files} filesError={session.filesError} filesLoading={session.filesLoading} hidden={false} onDownload={session.downloadSelectedFile} onRefresh={() => void session.refreshFiles()} onSelectPath={session.setSelectedPath} selectedPath={session.selectedPath} />
        </div>
      </section>
    </main>
  )
}
