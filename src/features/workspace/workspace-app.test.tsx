import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiSessionState, SessionSummary, SessionTask, WorkspaceFile, WorkspaceFileContent } from '~/shared/pi-contract'

type AgentOptions = {
  agent: string
  onMessage?: (message: MessageEvent) => void
  onClose?: (event: CloseEvent) => void
  onStateUpdate?: (state: PiSessionState, source: 'server' | 'client') => void
}
type RegistryOptions = { agent: string; onStateUpdate?: (state: { revision: number }, source: 'server' | 'client') => void }

const mocks = vi.hoisted(() => {
  const sessionAgent = {
    close: vi.fn(),
    stub: {
      abort: vi.fn(),
      listChanges: vi.fn(),
      listFiles: vi.fn(),
      listModels: vi.fn(),
      readChange: vi.fn(),
      readWorkspaceFile: vi.fn(),
      setModel: vi.fn(),
      steer: vi.fn(),
      submit: vi.fn(),
    },
  }
  const registryAgent = { stub: { getSession: vi.fn(), listRepositories: vi.fn(), listSessions: vi.fn(), renameSession: vi.fn() } }
  return {
    registryAgent,
    registryOptions: undefined as RegistryOptions | undefined,
    sessionAgent,
    sessionOptions: undefined as AgentOptions | undefined,
    useAgent: vi.fn(),
  }
})

vi.mock('agents/react', () => ({
  useAgent: mocks.useAgent,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params: _params, to, ...props }: React.ComponentProps<'a'> & { params?: unknown; to: string }) => <a href={to} {...props}>{children}</a>,
}))

import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { SessionRegistryProvider } from '~/features/sessions/session-registry'
import { WorkspaceApp } from './workspace-app'

/** The session page as the app shell hosts it: inside the sidebar and the shared registry. */
function renderWorkspace(ui: React.ReactElement) {
  return render(<Sidebar.Provider><SessionRegistryProvider>{ui}</SessionRegistryProvider></Sidebar.Provider>)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

const now = '2026-07-28T12:00:00.000Z'
const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-12345678', name: 'Current session', createdAt: now, updatedAt: now, ...overrides,
})
const file = (path: string, mtime = now): WorkspaceFile => ({ path, size: 10, mtime })
const fileContent = (path: string, content: string, mtime = now): WorkspaceFileContent => ({ ...file(path, mtime), content })
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

const userEntry = (text: string, id = 1): EntryRecord =>
  ({ id, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 0 }] }) as unknown as EntryRecord

function snapshot(entries: EntryRecord[], running = false): AgentEvent {
  return {
    type: 'snapshot', entries, tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} },
    ...(running ? { run: { inputs: [] } } : {}),
  } as AgentEvent
}

/** Deliver a `pi:events` frame as the PiSession connection would. */
function emit(...events: AgentEvent[]) {
  mocks.sessionOptions?.onMessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'pi:events', events }) }))
}

/** Deliver events and render the animation frame they are batched into. */
async function deliver(...events: AgentEvent[]) {
  await act(async () => {
    emit(...events)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  })
}

describe('WorkspaceApp', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.sessionOptions = undefined
    mocks.useAgent.mockImplementation((options: AgentOptions) => {
      if (options.agent === 'PiRegistry') {
        mocks.registryOptions = options as RegistryOptions
        return mocks.registryAgent
      }
      mocks.sessionOptions = options
      return mocks.sessionAgent
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    mocks.sessionAgent.stub.abort.mockResolvedValue(true)
    mocks.sessionAgent.stub.listFiles.mockResolvedValue([])
    mocks.sessionAgent.stub.listModels.mockResolvedValue([])
    mocks.sessionAgent.stub.setModel.mockResolvedValue(undefined)
    mocks.sessionAgent.stub.readWorkspaceFile.mockResolvedValue(fileContent('/workspace/default.ts', ''))
    mocks.sessionAgent.stub.submit.mockResolvedValue({ operationId: 'op-1', accepted: true })
    mocks.sessionAgent.stub.steer.mockResolvedValue({ operationId: 'op-2', accepted: true })
    mocks.registryAgent.stub.getSession.mockResolvedValue(summary())
    mocks.registryAgent.stub.listSessions.mockResolvedValue([])
    mocks.registryAgent.stub.renameSession.mockResolvedValue(summary({ name: 'Renamed' }))
  })

  it('connects to the session through the registry and renders its pi snapshot', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)

    expect(mocks.useAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: 'PiSession', basePath: 'api/agents/pi-registry/singleton/sessions/session-12345678' }))
    expect(mocks.useAgent).not.toHaveBeenCalledWith(expect.objectContaining({ agent: 'PiSession', name: expect.anything() }))
    expect(mocks.useAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: 'PiRegistry', name: 'singleton', prefix: 'api/agents' }))
    expect((screen.getByLabelText('Message Pi') as HTMLTextAreaElement).disabled).toBe(true)

    await deliver(snapshot([userEntry('current transcript')]))

    expect(screen.getByText('current transcript', { selector: '.message-body' })).toBeTruthy()
    expect((screen.getByLabelText('Message Pi') as HTMLTextAreaElement).disabled).toBe(false)
    expect(await screen.findByRole('button', { name: 'Current session' })).toBeTruthy()
  })

  it('submits prompts durably and follows the run through pi events', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))

    const input = screen.getByLabelText('Message Pi') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!)
    await waitFor(() => expect(mocks.sessionAgent.stub.submit).toHaveBeenCalledWith('Do work'))

    await deliver(...[
      { type: 'entry_appended', entry: userEntry('Do work', 2) },
      { type: 'run_start', inputs: [] },
      { type: 'message_start', message: { role: 'assistant', content: [], api: 'faux', provider: 'faux', model: 'faux', usage, stopReason: 'stop', timestamp: 0 } },
      { type: 'message_update', usage, changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: '' } }, { type: 'text_delta', contentIndex: 0, delta: 'Working' }] },
    ] as AgentEvent[])

    expect(screen.getByText('Do work', { selector: '.message-body' })).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()

    // While pi runs, a prompt steers it instead of starting a new run.
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: 'Use pnpm' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Steer' }).closest('form')!)
    await waitFor(() => expect(mocks.sessionAgent.stub.steer).toHaveBeenCalledWith('Use pnpm'))
    expect(mocks.sessionAgent.stub.submit).toHaveBeenCalledTimes(1)
    await deliver({ type: 'inbox_update', items: [{ id: 3, mode: 'steer' }] } as unknown as AgentEvent)
    expect(screen.getByText(/1 queued/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(mocks.sessionAgent.stub.abort).toHaveBeenCalled())

    await deliver({ type: 'run_end', inputs: [] }, { type: 'inbox_update', items: [] } as unknown as AgentEvent)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByText(/queued/)).toBeNull()
  })

  it('batches pi events into one animation-frame update', async () => {
    let renderFrame: FrameRequestCallback | undefined
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      renderFrame = callback
      return 1
    })
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)

    act(() => {
      emit(snapshot([], true), { type: 'message_start', message: { role: 'assistant', content: [], api: 'faux', provider: 'faux', model: 'faux', usage, stopReason: 'stop', timestamp: 0 } } as AgentEvent)
      emit({ type: 'message_update', usage, changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: '' } }, { type: 'text_delta', contentIndex: 0, delta: 'Hello' }] } as AgentEvent)
      emit({ type: 'message_update', usage, changes: [{ type: 'text_delta', contentIndex: 0, delta: ' world' }] } as AgentEvent)
    })
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Hello world')).toBeNull()

    act(() => renderFrame?.(performance.now()))
    expect(screen.getByText('Hello world')).toBeTruthy()
  })

  it('shows unanswered submissions and failed submits as errors', async () => {
    mocks.sessionAgent.stub.submit.mockRejectedValueOnce(new Error('A prompt is required.'))
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))

    fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toContain('A prompt is required.')
    expect((screen.getByLabelText('Message Pi') as HTMLTextAreaElement).value).toBe('Do work')

    await deliver({ type: 'submission', record: { status: 'unanswered', reason: 'no_model' } } as unknown as AgentEvent)
    expect(screen.getByRole('alert').textContent).toContain('A prompt is required.')
  })

  it('explains a failed session startup instead of loading forever', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)

    act(() => {
      mocks.sessionOptions?.onMessage?.(new MessageEvent('message', { data: JSON.stringify({ error: 'Error: pi could not open\n    at open (pi.js:1:1)' }) }))
      mocks.sessionOptions?.onClose?.(new CloseEvent('close', { code: 1011 }))
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The session could not start: Error: pi could not open')
    expect(alert.textContent).not.toContain('pi.js')

    // The client retries; the next snapshot clears the error.
    await deliver(snapshot([]))
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByLabelText('Message Pi') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('reports a lost connection until pi events resume', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))

    act(() => mocks.sessionOptions?.onClose?.(new CloseEvent('close', { code: 1006 })))
    expect((await screen.findByRole('alert')).textContent).toContain('Reconnecting')

    await deliver(snapshot([]))
    expect(screen.queryByRole('alert')).toBeNull()

    act(() => mocks.sessionOptions?.onClose?.(new CloseEvent('close', { code: 1000 })))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refreshes workspace files when a tool finishes', async () => {
    mocks.sessionAgent.stub.listFiles.mockResolvedValueOnce([]).mockResolvedValueOnce([file('/workspace/a.ts')])
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.listFiles).toHaveBeenCalledTimes(1))

    await deliver(snapshot([], true), { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'write' } as AgentEvent)

    await waitFor(() => expect(mocks.sessionAgent.stub.listFiles).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: /a\.ts/i })).toBeTruthy()
  })

  it('does not show a stale file response under a newly selected path', async () => {
    const firstRead = deferred<WorkspaceFileContent>()
    const secondRead = deferred<WorkspaceFileContent>()
    mocks.sessionAgent.stub.listFiles.mockResolvedValue([file('/workspace/a.ts'), file('/workspace/b.ts')])
    mocks.sessionAgent.stub.readWorkspaceFile.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise)

    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await waitFor(() => expect(mocks.sessionAgent.stub.readWorkspaceFile).toHaveBeenCalledWith('/workspace/a.ts'))
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /b\.ts/i }))
    await waitFor(() => expect(mocks.sessionAgent.stub.readWorkspaceFile).toHaveBeenCalledWith('/workspace/b.ts'))

    await act(async () => secondRead.resolve(fileContent('/workspace/b.ts', 'new file')))
    expect(await screen.findByText('new file')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => firstRead.resolve(fileContent('/workspace/a.ts', 'stale file')))
    expect(screen.queryByText('stale file')).toBeNull()
  })

  it('stops connecting to a session the registry does not hold', async () => {
    mocks.registryAgent.stub.getSession.mockResolvedValue(null)
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('This session does not exist'))
    expect(mocks.sessionAgent.close).toHaveBeenCalledOnce()
    // The 404'd socket's close must not replace the message with a reconnect notice.
    act(() => mocks.sessionOptions?.onClose?.(new CloseEvent('close', { code: 1006 })))
    expect(screen.getByRole('alert').textContent).toContain('This session does not exist')
  })

  it('renames the session through the registry', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Current session' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename session' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Renamed ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.registryAgent.stub.renameSession).toHaveBeenCalledWith('session-12345678', 'Renamed'))
    expect(await screen.findByRole('button', { name: 'Renamed' })).toBeTruthy()
  })

  it('follows the live catalog: a first prompt\'s title appears when the registry moves', async () => {
    mocks.registryAgent.stub.getSession.mockResolvedValue(summary({ name: undefined }))
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))
    expect(await screen.findByRole('button', { name: 'Untitled session-' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Fix the flaky test' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!)
    mocks.registryAgent.stub.listSessions.mockResolvedValue([summary({ name: undefined, title: 'Fix the flaky test' })])
    act(() => mocks.registryOptions?.onStateUpdate?.({ revision: 2 }, 'server'))

    expect(await screen.findByRole('button', { name: 'Fix the flaky test' })).toBeTruthy()
  })

  it('shows a repository task, its changes and its pull request', async () => {
    const task: SessionTask = { repo: 'octo/demo', baseBranch: 'main', baseCommit: 'abc', branch: 'pi/12345678', dir: '/workspace/demo' }
    mocks.sessionAgent.stub.listChanges.mockResolvedValue([
      { path: 'src/index.ts', status: 'M', insertions: 3, deletions: 1 },
      { path: 'README.md', status: 'A', insertions: 10, deletions: 0 },
    ])
    mocks.sessionAgent.stub.readChange.mockImplementation(async (path: string) => `diff --git a/${path} b/${path}\n+changed ${path}\n`)
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))
    expect(screen.queryByText('Changes')).toBeNull()

    act(() => mocks.sessionOptions?.onStateUpdate?.({ task, model: 'm' }, 'server'))

    expect(await screen.findByText('src/index.ts')).toBeTruthy()
    expect(screen.getByText('octo/demo · pi/12345678')).toBeTruthy()
    // The first change is selected, and its diff requested, after the list renders.
    await waitFor(() => expect(mocks.sessionAgent.stub.readChange).toHaveBeenCalledWith('src/index.ts'))
    expect(await screen.findByText(/\+changed src\/index\.ts/, { selector: 'pre.sr-only code' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }))
    await waitFor(() => expect(mocks.sessionAgent.stub.readChange).toHaveBeenCalledWith('README.md'))
    expect(screen.queryByRole('link', { name: /#7/ })).toBeNull()

    act(() => mocks.sessionOptions?.onStateUpdate?.({ task: { ...task, pullRequest: { number: 7, url: 'https://github.com/octo/demo/pull/7' } }, model: 'm' }, 'server'))
    expect(screen.getByRole('link', { name: /#7/ }).getAttribute('href')).toBe('https://github.com/octo/demo/pull/7')
  })

  it('suggests repositories after @ and inserts the one chosen', async () => {
    mocks.registryAgent.stub.listRepositories.mockResolvedValue([
      { repo: 'octo/demo', private: true },
      { repo: 'octo/other', private: false, description: 'The other one' },
      { repo: 'acme/site', private: false },
    ])
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))
    const field = screen.getByLabelText('Message Pi') as HTMLTextAreaElement
    expect(field.placeholder).toContain('type @')

    fireEvent.change(field, { target: { value: 'Fix the docs in @oct' } })
    expect(await screen.findByRole('button', { name: /octo\/demo/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /octo\/other/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /acme\/site/ })).toBeNull()

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: /octo\/other/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('Fix the docs in @octo/other ')
    expect(mocks.sessionAgent.stub.submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /octo\/demo/ })).toBeNull()

    // Loaded once, at the first @.
    fireEvent.change(field, { target: { value: 'Fix the docs in @octo/other and @ac' } })
    fireEvent.click(await screen.findByRole('button', { name: /acme\/site/ }))
    expect(field.value).toBe('Fix the docs in @octo/other and @acme/site ')
    expect(mocks.registryAgent.stub.listRepositories).toHaveBeenCalledTimes(1)

    fireEvent.change(field, { target: { value: '@zzz' } })
    expect(await screen.findByText(/No repository matches/)).toBeTruthy()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByText(/No repository matches/)).toBeNull()
  })

  it('shows the session\'s model and switches it', async () => {
    mocks.sessionAgent.stub.listModels.mockResolvedValue([{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }])
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    act(() => mocks.sessionOptions?.onStateUpdate?.({ task: null, model: 'model-a' }, 'server'))
    await deliver(snapshot([]))
    const picker = await screen.findByRole('combobox', { name: 'Model' })
    expect(picker.textContent).toContain('Model A')

    fireEvent.click(picker)
    // Base UI selects on a click that started on the option, as a mouse's does.
    const option = await screen.findByRole('option', { name: 'Model B' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    await waitFor(() => expect(mocks.sessionAgent.stub.setModel).toHaveBeenCalledWith('model-b'))
  })

  it('hides the model picker when the session offers no models', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))
    await waitFor(() => expect(mocks.sessionAgent.stub.listModels).toHaveBeenCalled())
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull()
  })

  it('stops suggesting repositories once the session has one', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))
    act(() => mocks.sessionOptions?.onStateUpdate?.({ task: { repo: 'octo/demo', baseBranch: 'main', baseCommit: 'abc', branch: 'pi/1', dir: '/workspace/demo' }, model: 'm' }, 'server'))
    const field = screen.getByLabelText('Message Pi') as HTMLTextAreaElement
    expect(field.placeholder).not.toContain('type @')

    fireEvent.change(field, { target: { value: 'compare with @oct' } })
    expect(mocks.registryAgent.stub.listRepositories).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Repositories')).toBeNull()
  })

  it('opens GitHub links at once and asks before any other', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const reply = { id: 2, conversationId: 1, kind: 'pi.assistant', model: [{
      role: 'assistant', api: 'faux', provider: 'faux', model: 'faux', usage, stopReason: 'stop', timestamp: 0,
      content: [{ type: 'text', text: 'Opened [pull request #4](https://github.com/octo/demo/pull/4). See [the docs](https://example.com/docs).' }],
    }] } as unknown as EntryRecord
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([userEntry('open a PR'), reply]))

    fireEvent.click(await screen.findByRole('button', { name: 'pull request #4' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://github.com/octo/demo/pull/4', '_blank', 'noreferrer'))
    expect(screen.queryByText('Open external link?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'the docs' }))
    expect(await screen.findByText('Open external link?')).toBeTruthy()
    expect(screen.getByText('https://example.com/docs')).toBeTruthy()
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }))
    expect(open).toHaveBeenLastCalledWith('https://example.com/docs', '_blank', 'noreferrer')
    await waitFor(() => expect(screen.queryByText('Open external link?')).toBeNull())
    open.mockRestore()
  })

  it('switches between the mobile Chat and Files views', async () => {
    renderWorkspace(<WorkspaceApp sessionId="session-12345678" />)
    const chatTab = screen.getByRole('tab', { name: 'Chat' })
    const filesTab = screen.getByRole('tab', { name: /Files/ })
    expect(chatTab.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(filesTab)
    await waitFor(() => expect(filesTab.getAttribute('aria-selected')).toBe('true'))
    expect(chatTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel', { name: /Files/ })).toBeTruthy()
  })
})
