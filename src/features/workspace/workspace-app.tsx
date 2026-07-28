import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { PromptComposer } from './components/prompt-composer'
import { TranscriptView } from './components/transcript-view'
import { WorkspaceBrowser } from './components/workspace-browser'
import { usePiSession } from './use-pi-session'

export function WorkspaceApp() {
  const session = usePiSession()
  const messageCount = session.entries.filter((entry) => entry.type === 'message').length

  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark">π</div>
          <div>
            <p className="eyebrow">EXPERIMENT 001 / WORKER NATIVE</p>
            <h1>PI ON CLOUDFLARE</h1>
          </div>
        </div>
        <div className="runtime-status">
          <span className="status-light" />
          WORKER ONLINE
        </div>
      </header>

      <section className="workbench">
        <aside className="rail">
          <div className="rail-section">
            <p className="rail-label">RUNTIME</p>
            <strong>workerd</strong>
            <span>Durable Object</span>
          </div>
          <div className="rail-section">
            <p className="rail-label">WORKSPACE</p>
            <strong>/workspace</strong>
            <span>SQLite backed</span>
          </div>
          <div className="rail-section tools-list">
            <p className="rail-label">TOOLS</p>
            {['READ', 'WRITE', 'EDIT', 'LIST', 'FIND', 'GREP'].map((tool) => <span key={tool}>{tool}</span>)}
          </div>
          <Button className="reset-button" variant="outline" onClick={session.reset} disabled={session.isRunning || session.isResetting || !session.isReady}>CLEAR CHAT</Button>
        </aside>

        <nav className="mobile-switcher" aria-label="Workspace view">
          <Tabs
            tabs={[
              { value: 'chat', label: 'CHAT', render: <button id="chat-tab" aria-controls="chat-panel" /> },
              { value: 'files', label: <>FILES <span>{session.files.length}</span></>, render: <button id="files-tab" aria-controls="files-panel" /> },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'files')}
            activateOnFocus
            className="mobile-tabs"
            listClassName="mobile-tabs-list"
            indicatorClassName="mobile-tabs-indicator"
          />
        </nav>

        <div
          id="chat-panel"
          className={`console-panel ${session.mobileView !== 'chat' ? 'mobile-hidden' : ''}`}
          role="tabpanel"
          aria-label="Chat"
          aria-labelledby="chat-tab"
        >
          <div className="console-header">
            <span>SESSION / {session.sessionId.toUpperCase()}</span>
            <span>{messageCount.toString().padStart(3, '0')} MSG</span>
          </div>

          <TranscriptView
            activeTextId={session.activeTextId}
            entries={session.entries}
            isRunning={session.isRunning}
            onScroll={session.handleTranscriptScroll}
            onTryOperation={() => session.setInput('Create /hello.ts with a Worker that returns “Hello from Pi”.')}
            transcriptRef={session.transcriptRef}
          />

          {session.error && <Banner className="error-banner" variant="error" role="alert" description={session.error} />}

          <PromptComposer
            input={session.input}
            isReady={session.isReady}
            isResetting={session.isResetting}
            isRunning={session.isRunning}
            onInputChange={session.setInput}
            onSubmit={session.submit}
          />
        </div>

        <WorkspaceBrowser
          canDownload={session.canDownload}
          fileContent={session.fileContent}
          fileError={session.fileError}
          files={session.files}
          filesError={session.filesError}
          filesLoading={session.filesLoading}
          hidden={session.mobileView !== 'files'}
          onDownload={session.downloadSelectedFile}
          onRefresh={() => void session.refreshFiles()}
          onSelectPath={session.setSelectedPath}
          selectedPath={session.selectedPath}
        />
      </section>
    </main>
  )
}
