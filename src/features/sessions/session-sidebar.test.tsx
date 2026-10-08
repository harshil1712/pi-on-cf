import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '~/shared/pi-contract'

type RegistryOptions = { onStateUpdate?: (state: { revision: number }, source: 'server' | 'client') => void }

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as { sessionId?: string },
  registry: {
    stub: {
      deleteSession: vi.fn(),
      listSessions: vi.fn(),
      renameSession: vi.fn(),
    },
  },
  registryOptions: undefined as RegistryOptions | undefined,
  useAgent: vi.fn(),
}))

vi.mock('agents/react', () => ({
  useAgent: mocks.useAgent,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
}))

import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { Toasty } from '@cloudflare/kumo/components/toast'
import { SessionRegistryProvider } from './session-registry'
import { SessionSidebar } from './session-sidebar'

const hour = 60 * 60 * 1000
const session = (overrides: Partial<SessionSummary> & { id: string }, ago = 0): SessionSummary => {
  const at = new Date(Date.now() - ago).toISOString()
  return { createdAt: at, updatedAt: at, ...overrides }
}

function renderSidebar() {
  return render(<Toasty><Sidebar.Provider><SessionRegistryProvider><SessionSidebar /></SessionRegistryProvider></Sidebar.Provider></Toasty>)
}

/** Open a session's actions menu and pick one. */
async function act_on(name: string, action: 'Rename' | 'Delete') {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
}

describe('SessionSidebar', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.params = {}
    mocks.useAgent.mockImplementation((options: RegistryOptions) => {
      mocks.registryOptions = options
      return mocks.registry
    })
    mocks.navigate.mockResolvedValue(undefined)
    mocks.registry.stub.deleteSession.mockResolvedValue(undefined)
    mocks.registry.stub.renameSession.mockResolvedValue(undefined)
    mocks.registry.stub.listSessions.mockResolvedValue([
      session({ id: 'named-session', name: 'Edge cache prototype', repo: 'octo/demo', pullRequest: { number: 7, url: 'https://github.com/octo/demo/pull/7' } }),
      session({ id: 'titled-session', title: 'Fix the flaky test' }, hour),
      session({ id: 'old-session-1' }, 30 * 24 * hour),
    ])
  })

  it('lists sessions by recency, by name, title or ID, with their repository and pull request', async () => {
    mocks.params = { sessionId: 'titled-session' }
    renderSidebar()

    const named = await screen.findByRole('link', { name: /Edge cache prototype/ })
    expect(named.getAttribute('href')).toBe('/sessions/named-session')
    expect(within(named).getByText('octo/demo')).toBeTruthy()
    expect(within(named).getByTitle('Pull request #7').textContent).toBe('7')
    expect(screen.getByRole('link', { name: 'Fix the flaky test' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Untitled old-sess' })).toBeTruthy()
    expect(screen.getByText('Older')).toBeTruthy()
  })

  it('reloads the list when the registry reports a change', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Edge cache prototype/ })

    mocks.registry.stub.listSessions.mockResolvedValue([session({ id: 'new-session', title: 'Add a README' })])
    act(() => mocks.registryOptions?.onStateUpdate?.({ revision: 5 }, 'server'))

    expect(await screen.findByRole('link', { name: 'Add a README' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Edge cache prototype/ })).toBeNull()
  })

  it('renames and deletes sessions from their menu', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Edge cache prototype/ })

    await act_on('Edge cache prototype', 'Rename')
    const input = await screen.findByLabelText('Name')
    fireEvent.change(input, { target: { value: 'Cache spike' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.registry.stub.renameSession).toHaveBeenCalledWith('named-session', 'Cache spike'))

    await act_on('Fix the flaky test', 'Delete')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mocks.registry.stub.deleteSession).toHaveBeenCalledWith('titled-session'))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('goes home after deleting the open session, and reports a failed delete', async () => {
    mocks.params = { sessionId: 'titled-session' }
    renderSidebar()
    await screen.findByRole('link', { name: 'Fix the flaky test' })

    await act_on('Fix the flaky test', 'Delete')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' }))

    mocks.registry.stub.deleteSession.mockRejectedValue(new Error('Session not found: named-session'))
    await act_on('Edge cache prototype', 'Delete')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Session not found: named-session')).toBeTruthy()
  })

  it('starts a new session from the header', async () => {
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' })
  })
})
