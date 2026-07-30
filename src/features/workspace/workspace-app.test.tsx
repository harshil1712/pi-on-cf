import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBranch, SessionOverview, StoredSessionEntry, WorkspaceFile, WorkspaceFileContent } from '../../shared/pi-contract'

const mocks = vi.hoisted(() => {
  const sessionAgent = {
    call: vi.fn(),
    stub: {
      abort: vi.fn(),
      compact: vi.fn(),
      getBranch: vi.fn(),
      getAppStatus: vi.fn(),
      initializeApp: vi.fn(),
      getOverview: vi.fn(),
      listFiles: vi.fn(),
      navigateTree: vi.fn(),
      readWorkspaceFile: vi.fn(),
      setEntryLabel: vi.fn(),
      setSessionName: vi.fn(),
      deployApp: vi.fn(),
    },
  }
  const registryAgent = { stub: { forkSession: vi.fn() } }
  return {
    navigate: vi.fn(),
    registryAgent,
    sessionAgent,
    useAgent: vi.fn((options: { agent: string }) => options.agent === 'PiRegistry' ? registryAgent : sessionAgent),
  }
})

vi.mock('agents/react', () => ({
  useAgent: mocks.useAgent,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params: _params, to, ...props }: React.ComponentProps<'a'> & { params?: unknown; to: string }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
}))

import { WorkspaceApp } from './workspace-app'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

const now = '2026-07-28T12:00:00.000Z'
const userEntry = (text: string, id = 'entry-1'): StoredSessionEntry => ({
  seq: 1,
  id,
  parentId: null,
  type: 'message',
  timestamp: now,
  message: { role: 'user', content: text },
})
const overview = (overrides: Partial<SessionOverview> = {}): SessionOverview => ({
  id: 'session-12345678',
  name: 'Current session',
  status: 'ready',
  createdAt: now,
  updatedAt: now,
  messageCount: 1,
  activeLeafId: 'entry-1',
  lineage: { type: 'new' },
  revision: 1,
  tree: [{
    seq: 1,
    id: 'entry-1',
    parentId: null,
    type: 'message',
    role: 'user',
    preview: 'current transcript',
    timestamp: now,
    isLeaf: true,
    isOnActiveBranch: true,
  }],
  compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 12_000 },
  ...overrides,
})
const branch = (text = 'current transcript'): SessionBranch => ({
  leafId: 'entry-1',
  revision: 1,
  entries: [userEntry(text)],
})
const file = (path: string, mtime = now): WorkspaceFile => ({ path, size: 10, mtime })
const fileContent = (path: string, content: string, mtime = now): WorkspaceFileContent => ({ ...file(path, mtime), content })

describe('WorkspaceApp orchestration', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockImplementation((options: { agent: string }) => options.agent === 'PiRegistry' ? mocks.registryAgent : mocks.sessionAgent)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    mocks.navigate.mockResolvedValue(undefined)
    mocks.sessionAgent.call.mockResolvedValue(undefined)
    mocks.sessionAgent.stub.abort.mockResolvedValue(undefined)
    mocks.sessionAgent.stub.compact.mockResolvedValue({ summary: '', tokensBefore: 0 })
    mocks.sessionAgent.stub.getOverview.mockResolvedValue(overview())
    mocks.sessionAgent.stub.getBranch.mockResolvedValue(branch())
    mocks.sessionAgent.stub.getAppStatus.mockResolvedValue({ initialized: true, sourceHash: 'source-hash', dirty: true })
    mocks.sessionAgent.stub.initializeApp.mockResolvedValue({ initialized: true, sourceHash: 'source-hash', dirty: true })
    mocks.sessionAgent.stub.listFiles.mockResolvedValue([])
    mocks.sessionAgent.stub.navigateTree.mockResolvedValue({})
    mocks.sessionAgent.stub.readWorkspaceFile.mockResolvedValue(fileContent('/default.ts', ''))
    mocks.sessionAgent.stub.setEntryLabel.mockResolvedValue(overview())
    mocks.sessionAgent.stub.setSessionName.mockResolvedValue(overview())
    mocks.sessionAgent.stub.deployApp.mockResolvedValue({
      sourceHash: 'source-hash', bundleHash: 'bundle-hash', templateCommit: 'template-commit', commitSha: 'commit-sha',
      workerId: 'worker-id', workerName: 'worker-name', versionId: 'version-id', deploymentId: 'deployment-id',
      productionUrl: 'https://worker.example.workers.dev', deployedAt: now,
    })
    mocks.registryAgent.stub.forkSession.mockResolvedValue({
      id: 'forked-session', name: 'Current session fork', status: 'ready', createdAt: now, updatedAt: now,
      messageCount: 1, activeLeafId: 'entry-1', lineage: { type: 'fork', parentSessionId: 'session-12345678', sourceEntryId: 'entry-1' },
    })
  })

  it('loads the named PiSession while keeping registry operations on PiRegistry', async () => {
    render(<WorkspaceApp sessionId="session-12345678" />)

    expect(await screen.findByText('current transcript', { selector: '.message-body' })).toBeTruthy()
    expect(mocks.useAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: 'PiSession', name: 'session-12345678', prefix: 'api/agents' }))
    expect(mocks.useAgent).toHaveBeenCalledWith({ agent: 'PiRegistry', name: 'singleton', prefix: 'api/agents' })
    expect(mocks.sessionAgent.stub.getOverview).toHaveBeenCalledTimes(1)
    expect(mocks.sessionAgent.stub.getBranch).toHaveBeenCalledWith()

    fireEvent.click(screen.getByRole('tab', { name: /TREE/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Fork from entry entry-1' }))
    await waitFor(() => expect(mocks.registryAgent.stub.forkSession).toHaveBeenCalledWith({
      sourceSessionId: 'session-12345678', entryId: 'entry-1', name: 'Current session fork',
    }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'forked-session' } })
  })

  it('deploys the current app and refreshes its deployment status', async () => {
    mocks.sessionAgent.stub.getAppStatus
      .mockResolvedValueOnce({ initialized: true, sourceHash: 'source-hash', dirty: true })
      .mockResolvedValueOnce({
        initialized: true,
        sourceHash: 'source-hash',
        dirty: false,
        deployment: await mocks.sessionAgent.stub.deployApp(),
      })
    mocks.sessionAgent.stub.deployApp.mockClear()
    render(<WorkspaceApp sessionId="session-12345678" />)

    const deployButton = await screen.findByRole('button', { name: 'DEPLOY' })
    expect(deployButton.closest('.right-panel')).toBeTruthy()
    expect(deployButton.closest('.workspace-masthead')).toBeNull()
    fireEvent.click(deployButton)

    await waitFor(() => expect(mocks.sessionAgent.stub.deployApp).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.sessionAgent.stub.getAppStatus).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'REDEPLOY' })).toBeTruthy()
  })

  it('hides app actions until the agent initializes an app', async () => {
    mocks.sessionAgent.stub.getAppStatus.mockResolvedValue({ initialized: false, sourceHash: '', dirty: false })
    render(<WorkspaceApp sessionId="session-12345678" />)

    await waitFor(() => expect(mocks.sessionAgent.stub.getAppStatus).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /START APP/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'PREVIEW' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'DEPLOY' })).toBeNull()
  })

  it('ignores getOverview and getBranch responses for an obsolete session', async () => {
    const staleOverview = deferred<SessionOverview>()
    const staleBranch = deferred<SessionBranch>()
    const currentOverview = deferred<SessionOverview>()
    const currentBranch = deferred<SessionBranch>()
    mocks.sessionAgent.stub.getOverview.mockReturnValueOnce(staleOverview.promise).mockReturnValueOnce(currentOverview.promise)
    mocks.sessionAgent.stub.getBranch.mockReturnValueOnce(staleBranch.promise).mockReturnValueOnce(currentBranch.promise)

    const view = render(<WorkspaceApp sessionId="old-session" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.getBranch).toHaveBeenCalledTimes(1))
    view.rerender(<WorkspaceApp sessionId="current-session" />)
    expect(screen.queryByText('current transcript', { selector: '.message-body' })).toBeNull()
    await waitFor(() => expect(mocks.sessionAgent.stub.getBranch).toHaveBeenCalledTimes(2))

    await act(async () => {
      currentOverview.resolve(overview({ id: 'current-session', name: 'Current session' }))
      currentBranch.resolve(branch('current transcript'))
    })
    expect(screen.getByText('current transcript', { selector: '.message-body' })).toBeTruthy()

    await act(async () => {
      staleOverview.resolve(overview({ id: 'old-session', name: 'Stale session' }))
      staleBranch.resolve(branch('stale transcript'))
    })
    expect(screen.queryByText('stale transcript')).toBeNull()
    expect(screen.getByText('current transcript', { selector: '.message-body' })).toBeTruthy()
  })

  it('clears the previous session before the new session finishes loading', async () => {
    const nextOverview = deferred<SessionOverview>()
    const nextBranch = deferred<SessionBranch>()
    mocks.sessionAgent.stub.getOverview.mockResolvedValueOnce(overview({ id: 'old-session' })).mockReturnValueOnce(nextOverview.promise)
    mocks.sessionAgent.stub.getBranch.mockResolvedValueOnce(branch('old transcript')).mockReturnValueOnce(nextBranch.promise)
    const view = render(<WorkspaceApp sessionId="old-session" />)
    await screen.findByText('old transcript', { selector: '.message-body' })

    view.rerender(<WorkspaceApp sessionId="new-session" />)

    expect(screen.queryByText('old transcript')).toBeNull()
    expect(screen.getAllByText('LOADING').length).toBeGreaterThan(0)
  })

  it('does not show a stale file response under a newly selected path', async () => {
    const firstRead = deferred<WorkspaceFileContent>()
    const secondRead = deferred<WorkspaceFileContent>()
    mocks.sessionAgent.stub.listFiles.mockResolvedValue([file('/a.ts'), file('/b.ts')])
    mocks.sessionAgent.stub.readWorkspaceFile.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise)

    render(<WorkspaceApp sessionId="session-12345678" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.readWorkspaceFile).toHaveBeenCalledWith('/a.ts'))
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /b\.ts/i }))
    await waitFor(() => expect(mocks.sessionAgent.stub.readWorkspaceFile).toHaveBeenCalledWith('/b.ts'))

    await act(async () => secondRead.resolve(fileContent('/b.ts', 'new file')))
    expect(await screen.findByText('new file')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => firstRead.resolve(fileContent('/a.ts', 'stale file')))
    expect(screen.queryByText('stale file')).toBeNull()
    expect(screen.getByText('new file')).toBeTruthy()
  })

  it('reloads the selected file when refreshed metadata changes', async () => {
    const updated = '2026-07-28T12:01:00.000Z'
    mocks.sessionAgent.stub.listFiles
      .mockResolvedValueOnce([file('/a.ts')])
      .mockResolvedValueOnce([file('/a.ts', updated)])
    mocks.sessionAgent.stub.readWorkspaceFile
      .mockResolvedValueOnce(fileContent('/a.ts', 'old content'))
      .mockResolvedValueOnce(fileContent('/a.ts', 'new content', updated))

    render(<WorkspaceApp sessionId="session-12345678" />)
    await screen.findByText('old content')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))

    expect(await screen.findByText('new content')).toBeTruthy()
    expect(mocks.sessionAgent.stub.readWorkspaceFile).toHaveBeenCalledTimes(2)
  })

  it('does not force scrolling after the user scrolls away from the bottom', async () => {
    render(<WorkspaceApp sessionId="session-12345678" />)
    const input = await screen.findByLabelText('INSTRUCTION')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    const transcript = document.querySelector<HTMLDivElement>('.transcript')!
    const scrollTo = vi.fn()
    Object.defineProperty(transcript, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 100, writable: true },
    })
    fireEvent.scroll(transcript)

    fireEvent.change(input, { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)
    await waitFor(() => expect(mocks.sessionAgent.call).toHaveBeenCalledWith('prompt', ['Do work'], expect.any(Object)))

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('restores auto-scroll when opening another session', async () => {
    const view = render(<WorkspaceApp sessionId="old-session" />)
    await screen.findByText('current transcript', { selector: '.message-body' })
    const oldTranscript = document.querySelector<HTMLDivElement>('.transcript')!
    Object.defineProperties(oldTranscript, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 100, writable: true },
    })
    fireEvent.scroll(oldTranscript)

    view.rerender(<WorkspaceApp sessionId="new-session" />)
    const newTranscript = document.querySelector<HTMLDivElement>('.transcript')!
    const scrollTo = vi.fn()
    Object.defineProperty(newTranscript, 'scrollTo', { configurable: true, value: scrollTo })
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
  })

  it('does not refresh an obsolete session when its action finishes', async () => {
    const compact = deferred<{ summary: string; tokensBefore: number }>()
    mocks.sessionAgent.stub.compact.mockReturnValueOnce(compact.promise)
    const view = render(<WorkspaceApp sessionId="old-session" />)
    await screen.findByText('current transcript', { selector: '.message-body' })

    fireEvent.click(screen.getByRole('button', { name: 'Compact session' }))
    await waitFor(() => expect(mocks.sessionAgent.stub.compact).toHaveBeenCalled())
    view.rerender(<WorkspaceApp sessionId="new-session" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.getOverview).toHaveBeenCalledTimes(2))

    await act(async () => compact.resolve({ summary: '', tokensBefore: 0 }))
    expect(mocks.sessionAgent.stub.getOverview).toHaveBeenCalledTimes(2)
  })

  it('shows errors received from the prompt stream', async () => {
    mocks.sessionAgent.call.mockImplementationOnce((
      _method: string,
      _args: unknown[],
      options: { stream: { onChunk: (chunk: unknown) => void } },
    ) => {
      options.stream.onChunk({ type: 'error', error: 'Model request failed.' })
      return Promise.resolve()
    })

    render(<WorkspaceApp sessionId="session-12345678" />)
    const input = await screen.findByLabelText('INSTRUCTION')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)

    expect((await screen.findByRole('alert')).textContent).toContain('Model request failed.')
  })

  it('batches stream chunks into one animation-frame update', async () => {
    const prompt = deferred<void>()
    let renderFrame: FrameRequestCallback | undefined
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      renderFrame = callback
      return 1
    })
    mocks.sessionAgent.call.mockImplementationOnce((
      _method: string,
      _args: unknown[],
      options: { stream: { onChunk: (chunk: unknown) => void } },
    ) => {
      options.stream.onChunk({ type: 'text_start' })
      options.stream.onChunk({ type: 'text_delta', delta: 'Hello' })
      options.stream.onChunk({ type: 'text_delta', delta: ' world' })
      return prompt.promise
    })

    render(<WorkspaceApp sessionId="session-12345678" />)
    const input = await screen.findByLabelText('INSTRUCTION')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)
    await waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Hello world')).toBeNull()

    act(() => renderFrame?.(performance.now()))
    expect(screen.getByText('Hello world')).toBeTruthy()
    await act(async () => prompt.resolve())
  })

  it('switches between the mobile CHAT, FILES, and TREE views with selected semantics', async () => {
    mocks.sessionAgent.stub.listFiles.mockResolvedValue([file('/a.ts'), file('/b.ts')])
    render(<WorkspaceApp sessionId="session-12345678" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.getOverview).toHaveBeenCalled())

    const chatTab = screen.getByRole('tab', { name: 'CHAT' })
    const filesTab = screen.getByRole('tab', { name: /FILES/ })
    const treeTab = screen.getByRole('tab', { name: /TREE/ })
    expect(chatTab.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(filesTab)
    await waitFor(() => expect(filesTab.getAttribute('aria-selected')).toBe('true'))
    expect(chatTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel', { name: /FILES/ })).toBeTruthy()

    fireEvent.click(treeTab)
    await waitFor(() => expect(treeTab.getAttribute('aria-selected')).toBe('true'))
    expect(filesTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel', { name: /TREE/ })).toBeTruthy()
  })

  it('exposes keyboard-operable desktop inspector tabs', async () => {
    render(<WorkspaceApp sessionId="session-12345678" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.getOverview).toHaveBeenCalled())
    const filesTab = screen.getByRole('tab', { name: 'Files inspector' })
    const treeTab = screen.getByRole('tab', { name: 'Tree inspector' })

    expect(filesTab.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(filesTab, { key: 'ArrowRight' })
    expect(treeTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(treeTab)
  })
})
