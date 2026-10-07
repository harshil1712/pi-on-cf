import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '~/shared/pi-contract'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  registry: {
    stub: {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      listSessions: vi.fn(),
      renameSession: vi.fn(),
    },
  },
  useAgent: vi.fn(),
}))

vi.mock('agents/react', () => ({
  useAgent: mocks.useAgent,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params: _params, to, ...props }: React.ComponentProps<'a'> & { params?: unknown; to: string }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
}))

import { SessionCatalog } from './session-catalog'

const now = '2026-07-28T12:00:00.000Z'
const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-12345678',
  name: 'Edge cache prototype',
  createdAt: now,
  updatedAt: now,
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
    mocks.registry.stub.createSession.mockResolvedValue(session({ id: 'created-session' }))
    mocks.registry.stub.renameSession.mockResolvedValue(session({ name: 'Renamed session' }))
    mocks.registry.stub.deleteSession.mockResolvedValue(undefined)
  })

  it('connects to the registry and renders its recent sessions', async () => {
    render(<SessionCatalog />)

    expect(await screen.findByText('Edge cache prototype')).toBeTruthy()
    expect(mocks.useAgent).toHaveBeenCalledWith({ agent: 'PiRegistry', name: 'singleton', prefix: 'api/agents' })
    expect(mocks.registry.stub.listSessions).toHaveBeenCalledWith()
  })

  it('creates a named session and opens its workspace', async () => {
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: '  New investigation  ' } })
    fireEvent.submit(screen.getByRole('button', { name: 'New session' }).closest('form')!)

    await waitFor(() => expect(mocks.registry.stub.createSession).toHaveBeenCalledWith({ name: 'New investigation' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'created-session' } })
  })

  it('routes rename and delete actions through the registry', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  Renamed session  ')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await waitFor(() => expect(mocks.registry.stub.renameSession).toHaveBeenCalledWith('session-12345678', 'Renamed session'))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Delete session' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    await waitFor(() => expect(mocks.registry.stub.deleteSession).toHaveBeenCalledWith('session-12345678'))
    expect(window.confirm).toHaveBeenCalledWith('Delete Edge cache prototype? This cannot be undone.')
  })

  it('refreshes relative timestamps while the catalog remains open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T12:00:30.000Z'))
    render(<SessionCatalog />)
    await act(async () => { await Promise.resolve() })

    const timestamp = document.querySelector('time')
    expect(timestamp?.dateTime).toBe(now)
    const initialText = timestamp?.textContent

    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(timestamp?.textContent).not.toBe(initialText)
  })
})
