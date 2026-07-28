import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSearchResult, SessionSummary } from '../shared/pi-contract'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  registry: {
    stub: {
      cloneSession: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      forkSession: vi.fn(),
      listSessions: vi.fn(),
      renameSession: vi.fn(),
      searchSessions: vi.fn(),
    },
  },
  useAgent: vi.fn(),
}))

vi.mock('agents/react', () => ({
  useAgent: mocks.useAgent,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, params: _params, to, ...props }: React.ComponentProps<'a'> & { params?: unknown; to: string }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
}))

import { Home } from './index'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

const now = '2026-07-28T12:00:00.000Z'
const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-12345678',
  name: 'Edge cache prototype',
  status: 'ready',
  createdAt: now,
  updatedAt: now,
  messageCount: 4,
  activeLeafId: 'entry-4',
  lineage: { type: 'new' },
  ...overrides,
})

describe('SessionCatalog', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockReturnValue(mocks.registry)
    mocks.navigate.mockResolvedValue(undefined)
    mocks.registry.stub.listSessions.mockResolvedValue([session()])
    mocks.registry.stub.searchSessions.mockResolvedValue([])
    mocks.registry.stub.createSession.mockResolvedValue(session({ id: 'created-session' }))
    mocks.registry.stub.renameSession.mockResolvedValue(session({ name: 'Renamed session' }))
    mocks.registry.stub.deleteSession.mockResolvedValue(undefined)
    mocks.registry.stub.cloneSession.mockResolvedValue(session({ id: 'cloned-session', lineage: { type: 'clone', parentSessionId: 'session-12345678' } }))
  })

  it('connects to the registry and renders its recent sessions', async () => {
    render(<Home />)

    expect(await screen.findByText('Edge cache prototype')).toBeTruthy()
    expect(screen.getByText('4 MSG / NEW', { exact: false })).toBeTruthy()
    expect(mocks.useAgent).toHaveBeenCalledWith({ agent: 'PiRegistry', name: 'singleton', prefix: 'api/agents' })
    expect(mocks.registry.stub.listSessions).toHaveBeenCalledWith({ query: undefined, limit: 100, sort: 'recent' })
  })

  it('creates a named session and opens its workspace', async () => {
    render(<Home />)
    await screen.findByText('Edge cache prototype')

    fireEvent.change(screen.getByLabelText('SESSION NAME OPTIONAL'), { target: { value: '  New investigation  ' } })
    fireEvent.submit(screen.getByRole('button', { name: 'CREATE SESSION' }).closest('form')!)

    await waitFor(() => expect(mocks.registry.stub.createSession).toHaveBeenCalledWith({ name: 'New investigation' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'created-session' } })
  })

  it('does not render results from an older search that finishes last', async () => {
    const oldSearch = deferred<SessionSearchResult[]>()
    const currentSearch = deferred<SessionSearchResult[]>()
    mocks.registry.stub.searchSessions
      .mockReturnValueOnce(oldSearch.promise)
      .mockReturnValueOnce(currentSearch.promise)

    render(<Home />)
    await screen.findByText('Edge cache prototype')
    const search = screen.getByLabelText('Search sessions and messages')

    fireEvent.change(search, { target: { value: 'old query' } })
    fireEvent.submit(search.closest('form')!)
    await waitFor(() => expect(mocks.registry.stub.searchSessions).toHaveBeenCalledWith({ query: 'old query', limit: 30, sort: 'relevance' }))

    fireEvent.change(search, { target: { value: 'current query' } })
    fireEvent.submit(search.closest('form')!)
    await waitFor(() => expect(mocks.registry.stub.searchSessions).toHaveBeenCalledWith({ query: 'current query', limit: 30, sort: 'relevance' }))

    currentSearch.resolve([{
      session: session(),
      matches: [{ entryId: 'current-entry', role: 'assistant', timestamp: now, text: 'current result' }],
    }])
    expect(await screen.findByText('current result')).toBeTruthy()

    oldSearch.resolve([{
      session: session(),
      matches: [{ entryId: 'old-entry', role: 'assistant', timestamp: now, text: 'stale result' }],
    }])
    await waitFor(() => expect(screen.queryByText('stale result')).toBeNull())
    expect(screen.getByText('current result')).toBeTruthy()
  })

  it('routes rename, clone, and delete actions through the registry', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  Renamed session  ')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Home />)
    await screen.findByText('Edge cache prototype')

    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await waitFor(() => expect(mocks.registry.stub.renameSession).toHaveBeenCalledWith('session-12345678', 'Renamed session'))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Clone session' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Clone session' }))
    await waitFor(() => expect(mocks.registry.stub.cloneSession).toHaveBeenCalledWith({ sourceSessionId: 'session-12345678', name: 'Edge cache prototype copy' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'cloned-session' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Delete session' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    await waitFor(() => expect(mocks.registry.stub.deleteSession).toHaveBeenCalledWith('session-12345678'))
    expect(window.confirm).toHaveBeenCalledWith('Delete Edge cache prototype? This cannot be undone.')
  })

  it('refreshes relative timestamps while the catalog remains open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T12:00:30.000Z'))
    render(<Home />)
    await act(async () => { await Promise.resolve() })

    const timestamp = document.querySelector('time')
    expect(timestamp?.dateTime).toBe(now)
    const initialText = timestamp?.textContent

    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(timestamp?.textContent).not.toBe(initialText)
  })
})
