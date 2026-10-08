import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '~/shared/pi-contract'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  registry: {
    stub: {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      listRepositories: vi.fn(),
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

  it('starts a session from a prompt and opens its workspace', async () => {
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: '  Fix the flaky test  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(mocks.registry.stub.createSession).toHaveBeenCalledWith({ prompt: 'Fix the flaky test' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'created-session' } })
  })

  it('keeps the prompt when the session cannot start', async () => {
    mocks.registry.stub.createSession.mockRejectedValue(new Error('No capacity'))
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    const field = screen.getByLabelText('Message Pi') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Fix the flaky test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect((await screen.findByRole('alert')).textContent).toContain('No capacity')
    expect(field.value).toBe('Fix the flaky test')
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('suggests repositories from the registry', async () => {
    mocks.registry.stub.listRepositories.mockResolvedValue([{ repo: 'octo/demo', private: false }])
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    const field = screen.getByLabelText('Message Pi') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '@oc' } })

    expect(await screen.findByText('octo/demo')).toBeTruthy()
    expect(mocks.registry.stub.listRepositories).toHaveBeenCalledTimes(1)
  })

  it('still creates an empty session', async () => {
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

    await waitFor(() => expect(mocks.registry.stub.createSession).toHaveBeenCalledWith())
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 'created-session' } })
  })

  it('lists an unnamed session by the title of its first prompt', async () => {
    mocks.registry.stub.listSessions.mockResolvedValue([session({ name: undefined, title: 'Fix the flaky test', repo: 'octo/demo', branch: 'pi/12345678' })])
    render(<SessionCatalog />)

    expect(await screen.findByText('Fix the flaky test', { selector: '.font-medium' })).toBeTruthy()
    expect(screen.getByText('octo/demo · pi/12345678')).toBeTruthy()
  })

  it('lists a session\'s repository, branch and pull request', async () => {
    mocks.registry.stub.listSessions.mockResolvedValue([
      session({ name: undefined, repo: 'octo/demo', branch: 'pi/12345678', pullRequest: { number: 7, url: 'https://github.com/octo/demo/pull/7' } }),
    ])
    render(<SessionCatalog />)

    expect(await screen.findByText('octo/demo · pi/12345678')).toBeTruthy()
    expect(screen.getByText('octo/demo', { selector: '.font-medium' })).toBeTruthy()
    expect(screen.getByText('#7')).toBeTruthy()
    expect(screen.queryByLabelText('Repository')).toBeNull()
  })

  it('routes rename and delete actions through the registry', async () => {
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    const renameDialog = await screen.findByRole('dialog', { name: 'Rename session' })
    const nameField = within(renameDialog).getByLabelText('Name') as HTMLInputElement
    expect(nameField.value).toBe('Edge cache prototype')
    fireEvent.change(nameField, { target: { value: '  Renamed session  ' } })
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.registry.stub.renameSession).toHaveBeenCalledWith('session-12345678', 'Renamed session'))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Delete session' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    const deleteDialog = await screen.findByRole('alertdialog', { name: 'Delete session?' })
    expect(deleteDialog.textContent).toContain('Edge cache prototype and its workspace files will be deleted.')
    expect(mocks.registry.stub.deleteSession).not.toHaveBeenCalled()
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mocks.registry.stub.deleteSession).toHaveBeenCalledWith('session-12345678'))
  })

  it('leaves the session alone when a dialog is cancelled', async () => {
    render(<SessionCatalog />)
    await screen.findByText('Edge cache prototype')

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(mocks.registry.stub.deleteSession).not.toHaveBeenCalled()
    expect(mocks.registry.stub.renameSession).not.toHaveBeenCalled()
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
