import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const agent = vi.hoisted(() => ({
  call: vi.fn(),
  stub: {
    clearTranscript: vi.fn(),
    listFiles: vi.fn(),
    loadTranscript: vi.fn(),
    readWorkspaceFile: vi.fn(),
  },
}))

vi.mock('agents/react', () => ({
  useAgent: () => agent,
}))

import { Home } from './index'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const file = (path: string, mtime = '2026-01-01T00:00:00.000Z') => ({ path, size: 10, mtime })

describe('Home synchronization', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    agent.call.mockResolvedValue(undefined)
    agent.stub.clearTranscript.mockResolvedValue(undefined)
    agent.stub.listFiles.mockResolvedValue([])
    agent.stub.loadTranscript.mockResolvedValue([])
    agent.stub.readWorkspaceFile.mockResolvedValue({ ...file('/default.ts'), content: '' })
  })

  it('ignores transcript responses from a cleaned-up effect', async () => {
    const first = deferred<unknown[]>()
    const second = deferred<unknown[]>()
    agent.stub.loadTranscript.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    render(<StrictMode><Home /></StrictMode>)
    await waitFor(() => expect(agent.stub.loadTranscript).toHaveBeenCalledTimes(2))

    await act(async () => second.resolve([{ role: 'user', content: 'current transcript' }]))
    expect(screen.getByText('current transcript')).toBeTruthy()

    await act(async () => first.resolve([{ role: 'user', content: 'stale transcript' }]))
    expect(screen.queryByText('stale transcript')).toBeNull()
    expect(screen.getByText('current transcript')).toBeTruthy()
  })

  it('does not show a stale file response under a newly selected path', async () => {
    const firstRead = deferred<{ path: string; content: string; size: number; mtime: string }>()
    const secondRead = deferred<{ path: string; content: string; size: number; mtime: string }>()
    agent.stub.listFiles.mockResolvedValue([file('/a.ts'), file('/b.ts')])
    agent.stub.readWorkspaceFile.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise)

    render(<Home />)
    await waitFor(() => expect(agent.stub.readWorkspaceFile).toHaveBeenCalledWith('/a.ts'))
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /b\.ts/i }))
    await waitFor(() => expect(agent.stub.readWorkspaceFile).toHaveBeenCalledWith('/b.ts'))

    await act(async () => secondRead.resolve({ ...file('/b.ts'), content: 'new file' }))
    expect(screen.getByText('new file')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => firstRead.resolve({ ...file('/a.ts'), content: 'stale file' }))
    expect(screen.queryByText('stale file')).toBeNull()
    expect(screen.getByText('new file')).toBeTruthy()
  })

  it('reloads the selected file when refreshed metadata changes', async () => {
    agent.stub.listFiles
      .mockResolvedValueOnce([file('/a.ts')])
      .mockResolvedValueOnce([file('/a.ts', '2026-01-02T00:00:00.000Z')])
    agent.stub.readWorkspaceFile
      .mockResolvedValueOnce({ ...file('/a.ts'), content: 'old content' })
      .mockResolvedValueOnce({ ...file('/a.ts', '2026-01-02T00:00:00.000Z'), content: 'new content' })

    render(<Home />)
    await screen.findByText('old content')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))

    expect(await screen.findByText('new content')).toBeTruthy()
    expect(agent.stub.readWorkspaceFile).toHaveBeenCalledTimes(2)
  })

  it('does not force scrolling after the user scrolls away from the bottom', async () => {
    render(<Home />)
    await waitFor(() => expect((screen.getByLabelText('INSTRUCTION') as HTMLTextAreaElement).disabled).toBe(false))
    const transcript = document.querySelector<HTMLDivElement>('.transcript')!
    const scrollTo = transcript.scrollTo as ReturnType<typeof vi.fn>
    scrollTo.mockClear()
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 100, writable: true },
    })
    fireEvent.scroll(transcript)

    fireEvent.change(screen.getByLabelText('INSTRUCTION'), { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)
    await waitFor(() => expect(agent.call).toHaveBeenCalled())

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('switches between the mobile workspace tabs with selected semantics', async () => {
    render(<Home />)
    await waitFor(() => expect(agent.stub.listFiles).toHaveBeenCalled())

    const chatTab = screen.getByRole('tab', { name: 'CHAT' })
    const filesTab = screen.getByRole('tab', { name: /FILES/ })
    expect(chatTab.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(filesTab)

    await waitFor(() => expect(filesTab.getAttribute('aria-selected')).toBe('true'))
    expect(chatTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel', { name: /FILES/ })).toBeTruthy()
  })

  it('shows errors received from the prompt stream', async () => {
    agent.call.mockImplementationOnce((
      _method: string,
      _args: unknown[],
      options: { stream: { onChunk: (chunk: unknown) => void } },
    ) => {
      options.stream.onChunk({ type: 'error', error: 'Model request failed.' })
      return Promise.resolve()
    })

    render(<Home />)
    const input = await screen.findByLabelText('INSTRUCTION')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Do work' } })
    fireEvent.submit(screen.getByRole('button', { name: /execute/i }).closest('form')!)

    expect((await screen.findByRole('alert')).textContent).toContain('Model request failed.')
  })

  it('disables prompting while the transcript is being cleared', async () => {
    const clearing = deferred<void>()
    agent.stub.clearTranscript.mockReturnValueOnce(clearing.promise)

    render(<Home />)
    const input = await screen.findByLabelText('INSTRUCTION')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'CLEAR CHAT' }))

    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(true))
    await act(async () => clearing.resolve())
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
  })
})
