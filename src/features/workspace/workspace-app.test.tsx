import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary, WorkspaceFile, WorkspaceFileContent } from '../../shared/pi-contract'

type AgentOptions = { agent: string; onMessage?: (message: MessageEvent) => void }

const mocks = vi.hoisted(() => {
  const sessionAgent = {
    stub: {
      abort: vi.fn(),
      listFiles: vi.fn(),
      readWorkspaceFile: vi.fn(),
      steer: vi.fn(),
      submit: vi.fn(),
    },
  }
  const registryAgent = { stub: { getSession: vi.fn(), renameSession: vi.fn() } }
  return {
    registryAgent,
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

import { WorkspaceApp } from './workspace-app'

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
      if (options.agent === 'PiRegistry') return mocks.registryAgent
      mocks.sessionOptions = options
      return mocks.sessionAgent
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    mocks.sessionAgent.stub.abort.mockResolvedValue(true)
    mocks.sessionAgent.stub.listFiles.mockResolvedValue([])
    mocks.sessionAgent.stub.readWorkspaceFile.mockResolvedValue(fileContent('/workspace/default.ts', ''))
    mocks.sessionAgent.stub.submit.mockResolvedValue({ operationId: 'op-1', accepted: true })
    mocks.registryAgent.stub.getSession.mockResolvedValue(summary())
    mocks.registryAgent.stub.renameSession.mockResolvedValue(summary({ name: 'Renamed' }))
  })

  it('connects to the named PiSession and renders its pi snapshot', async () => {
    render(<WorkspaceApp sessionId="session-12345678" />)

    expect(mocks.useAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: 'PiSession', name: 'session-12345678', prefix: 'api/agents' }))
    expect(mocks.useAgent).toHaveBeenCalledWith({ agent: 'PiRegistry', name: 'singleton', prefix: 'api/agents' })
    expect((screen.getByLabelText('INSTRUCTION') as HTMLTextAreaElement).disabled).toBe(true)

    await deliver(snapshot([userEntry('current transcript')]))

    expect(screen.getByText('current transcript', { selector: '.message-body' })).toBeTruthy()
    expect((screen.getByLabelText('INSTRUCTION') as HTMLTextAreaElement).disabled).toBe(false)
    expect(await screen.findByRole('button', { name: 'Current session' })).toBeTruthy()
  })

  it('submits prompts durably and follows the run through pi events', async () => {
    render(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))

    const input = screen.getByLabelText('INSTRUCTION') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)
    await waitFor(() => expect(mocks.sessionAgent.stub.submit).toHaveBeenCalledWith('Do work'))

    await deliver(...[
      { type: 'entry_appended', entry: userEntry('Do work', 2) },
      { type: 'run_start', inputs: [] },
      { type: 'message_start', message: { role: 'assistant', content: [], api: 'faux', provider: 'faux', model: 'faux', usage, stopReason: 'stop', timestamp: 0 } },
      { type: 'message_update', usage, changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: '' } }, { type: 'text_delta', contentIndex: 0, delta: 'Working' }] },
    ] as AgentEvent[])

    expect(screen.getByText('Do work', { selector: '.message-body' })).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(input.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /abort/i }))
    await waitFor(() => expect(mocks.sessionAgent.stub.abort).toHaveBeenCalled())

    await deliver({ type: 'run_end', inputs: [] })
    expect(input.disabled).toBe(false)
  })

  it('batches pi events into one animation-frame update', async () => {
    let renderFrame: FrameRequestCallback | undefined
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      renderFrame = callback
      return 1
    })
    render(<WorkspaceApp sessionId="session-12345678" />)

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
    render(<WorkspaceApp sessionId="session-12345678" />)
    await deliver(snapshot([]))

    fireEvent.change(screen.getByLabelText('INSTRUCTION'), { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toContain('A prompt is required.')
    expect((screen.getByLabelText('INSTRUCTION') as HTMLTextAreaElement).value).toBe('Do work')

    await deliver({ type: 'submission', record: { status: 'unanswered', reason: 'no_model' } } as unknown as AgentEvent)
    expect(screen.getByRole('alert').textContent).toContain('A prompt is required.')
  })

  it('refreshes workspace files when a tool finishes', async () => {
    mocks.sessionAgent.stub.listFiles.mockResolvedValueOnce([]).mockResolvedValueOnce([file('/workspace/a.ts')])
    render(<WorkspaceApp sessionId="session-12345678" />)
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

    render(<WorkspaceApp sessionId="session-12345678" />)
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

  it('renames the session through the registry', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Renamed')
    render(<WorkspaceApp sessionId="session-12345678" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Current session' }))

    await waitFor(() => expect(mocks.registryAgent.stub.renameSession).toHaveBeenCalledWith('session-12345678', 'Renamed'))
    expect(await screen.findByRole('button', { name: 'Renamed' })).toBeTruthy()
  })

  it('switches between the mobile CHAT and FILES views', async () => {
    render(<WorkspaceApp sessionId="session-12345678" />)
    const chatTab = screen.getByRole('tab', { name: 'CHAT' })
    const filesTab = screen.getByRole('tab', { name: /FILES/ })
    expect(chatTab.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(filesTab)
    await waitFor(() => expect(filesTab.getAttribute('aria-selected')).toBe('true'))
    expect(chatTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel', { name: /FILES/ })).toBeTruthy()
  })
})
