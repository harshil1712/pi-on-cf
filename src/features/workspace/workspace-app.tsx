import { Link, useNavigate } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { ArrowLeft, GitCommitHorizontal, Scissors, Square } from 'lucide-react'
import { PromptComposer } from './components/prompt-composer'
import { SessionTree } from './components/session-tree'
import { TranscriptView } from './components/transcript-view'
import { WorkspaceBrowser } from './components/workspace-browser'
import { usePiSession } from './use-pi-session'

export function WorkspaceApp({ sessionId }: { sessionId: string }) {
  return <WorkspaceSession key={sessionId} sessionId={sessionId} />
}

function WorkspaceSession({ sessionId }: { sessionId: string }) {
  const session = usePiSession(sessionId)
  const navigate = useNavigate()
  const messageCount = session.entries.filter((entry) => entry.type === 'message').length
  const name = session.overview?.name || `UNTITLED / ${sessionId.slice(0, 8)}`
  const lineage = session.overview?.lineage

  function rename() {
    const next = window.prompt('Session name', session.overview?.name ?? '')
    if (next !== null) void session.rename(next.trim())
  }

  async function fork(entryId: string) {
    try {
      const forked = await session.fork(entryId, `${session.overview?.name || 'Untitled'} fork`)
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: forked.id } })
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <main className="app-shell">
      <header className="masthead workspace-masthead">
        <div className="brand-lockup">
          <Link to="/" className="back-button" aria-label="Back to sessions"><ArrowLeft size={19} /></Link>
          <div className="brand-mark">π</div>
          <div className="session-title">
            <p className="eyebrow">SESSION / {sessionId}</p>
            <h1><button onClick={rename} disabled={!session.overview || Boolean(session.pendingAction)} title="Rename session">{name}</button></h1>
            <p className="lineage-line">
              {lineage?.type.toUpperCase() || 'LOADING'}
              {lineage?.parentSessionId && <> FROM <Link to="/sessions/$sessionId" params={{ sessionId: lineage.parentSessionId }}>{lineage.parentSessionId.slice(0, 8)}</Link></>}
            </p>
          </div>
        </div>
        <div className="runtime-status"><span className="status-light" />WORKER ONLINE</div>
        <div className="mobile-session-actions">
          <Button shape="square" size="sm" variant="outline" aria-label="Compact session" title="Compact session" disabled={session.isRunning || Boolean(session.pendingAction) || !session.isReady} onClick={() => void session.compact()} icon={<Scissors size={15} />} />
        </div>
      </header>

      <section className="workbench">
        <aside className="rail">
          <div className="rail-section"><p className="rail-label">BRANCH</p><strong>{session.overview?.activeLeafId?.slice(0, 8) || 'NO LEAF'}</strong><span>rev {session.overview?.revision ?? 0}</span></div>
          <div className="rail-section"><p className="rail-label">LINEAGE</p><strong>{lineage?.type.toUpperCase() || '...'}</strong><span>{session.overview?.messageCount ?? 0} indexed messages</span></div>
          <div className="rail-section tools-list"><p className="rail-label">TOOLS</p>{['READ', 'WRITE', 'EDIT', 'LIST', 'FIND', 'GREP'].map((tool) => <span key={tool}>{tool}</span>)}</div>
          <div className="rail-actions">
            {session.isRunning && <Button className="reset-button abort-button" variant="outline" onClick={() => void session.abort()}><Square size={12} fill="currentColor" /> ABORT</Button>}
            <Button className="reset-button" variant="outline" onClick={() => void session.compact()} disabled={session.isRunning || Boolean(session.pendingAction) || !session.isReady}><Scissors size={13} /> {session.pendingAction === 'compact' ? 'COMPACTING' : 'COMPACT NOW'}</Button>
          </div>
        </aside>

        <nav className="mobile-switcher" aria-label="Workspace view">
          <Tabs
            tabs={[
              { value: 'chat', label: 'CHAT', render: <button id="chat-tab" aria-label="CHAT" aria-controls="chat-panel" /> },
              { value: 'files', label: <>FILES <span>{session.files.length}</span></>, render: <button id="files-tab" aria-label="FILES" aria-controls="files-panel" /> },
              { value: 'tree', label: <>TREE <span>{session.overview?.tree.length ?? 0}</span></>, render: <button id="tree-tab" aria-label="TREE" aria-controls="tree-panel" /> },
            ]}
            value={session.mobileView}
            onValueChange={(value) => session.setMobileView(value as 'chat' | 'files' | 'tree')}
            activateOnFocus className="mobile-tabs" listClassName="mobile-tabs-list" indicatorClassName="mobile-tabs-indicator"
          />
        </nav>

        <div id="chat-panel" className={`console-panel ${session.mobileView !== 'chat' ? 'mobile-hidden' : ''}`} role="tabpanel" aria-label="Chat" aria-labelledby="chat-tab">
          <div className="console-header"><span>ACTIVE / {name.toUpperCase()}</span><span>{messageCount.toString().padStart(3, '0')} MSG</span></div>
          <TranscriptView activeTextId={session.activeTextId} entries={session.entries} isRunning={session.isRunning} onScroll={session.handleTranscriptScroll} onTryOperation={() => session.setInput('Create /hello.ts with a Worker that returns “Hello from Pi”.')} transcriptRef={session.transcriptRef} />
          {session.error && <Banner className="error-banner" variant="error" role="alert" description={session.error} />}
          <PromptComposer input={session.input} isReady={session.isReady} isResetting={Boolean(session.pendingAction)} isRunning={session.isRunning} onAbort={() => void session.abort()} onInputChange={session.setInput} onSubmit={session.submit} />
        </div>

        <div className={`right-panel ${session.mobileView === 'chat' ? 'mobile-hidden' : ''}`}>
          <div className="desktop-panel-tabs" aria-label="Inspector view" role="tablist">
            <button id="desktop-files-tab" role="tab" aria-label="Files inspector" aria-controls="files-panel" aria-selected={session.desktopPanel === 'files'} tabIndex={session.desktopPanel === 'files' ? 0 : -1} className={session.desktopPanel === 'files' ? 'active' : ''} onClick={() => session.setDesktopPanel('files')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { session.setDesktopPanel('tree'); document.getElementById('desktop-tree-tab')?.focus() } }}><GitCommitHorizontal size={14} /> FILES</button>
            <button id="desktop-tree-tab" role="tab" aria-label="Tree inspector" aria-controls="tree-panel" aria-selected={session.desktopPanel === 'tree'} tabIndex={session.desktopPanel === 'tree' ? 0 : -1} className={session.desktopPanel === 'tree' ? 'active' : ''} onClick={() => session.setDesktopPanel('tree')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { session.setDesktopPanel('files'); document.getElementById('desktop-files-tab')?.focus() } }}><GitCommitHorizontal size={14} /> TREE</button>
          </div>
          <WorkspaceBrowser canDownload={session.canDownload} fileContent={session.fileContent} fileError={session.fileError} files={session.files} filesError={session.filesError} filesLoading={session.filesLoading} hidden={(session.mobileView === 'files' ? false : session.mobileView === 'tree' ? true : session.desktopPanel !== 'files')} onDownload={session.downloadSelectedFile} onRefresh={() => void session.refreshFiles()} onSelectPath={session.setSelectedPath} selectedPath={session.selectedPath} />
          <SessionTree hidden={(session.mobileView === 'tree' ? false : session.mobileView === 'files' ? true : session.desktopPanel !== 'tree')} overview={session.overview} pending={Boolean(session.pendingAction) || session.isRunning} onFork={(entryId) => void fork(entryId)} onLabel={(entryId, label) => void session.setEntryLabel(entryId, label)} onNavigate={(entryId) => void session.navigateTree(entryId)} />
        </div>
      </section>
    </main>
  )
}
