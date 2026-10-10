import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import type { SessionSummary } from '~/contract'
import { AgentConnectionProvider } from '~/hooks/use-agent-connection'
import { SessionRegistryProvider } from '~/hooks/use-session-registry'
import { HomePage } from '~/components/home-page'
import { renderAtPath } from '../render-at-path'

const mocks = {
  registry: {
    stub: {
      createSession: vi.fn(),
      listModels: vi.fn(),
      listRepositories: vi.fn(),
      listSessions: vi.fn(),
    },
  },
  useAgent: vi.fn(),
}

const now = '2026-07-28T12:00:00.000Z'

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-12345678', status: 'idle', createdAt: now, updatedAt: now, ...overrides,
})

/** The app's providers, over a fake registry connection. */
function Providers({ children }: { children: ReactNode }) {
  return <AgentConnectionProvider value={mocks.useAgent}><Sidebar.Provider><SessionRegistryProvider>{children}</SessionRegistryProvider></Sidebar.Provider></AgentConnectionProvider>
}

function renderHome() {
  return renderAtPath(<HomePage />, { wrapper: Providers })
}

const field = () => screen.getByLabelText<HTMLTextAreaElement>('Message Pi')

describe('HomePage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockReturnValue(mocks.registry)
    mocks.registry.stub.listSessions.mockResolvedValue([])
    mocks.registry.stub.listModels.mockResolvedValue([])
    mocks.registry.stub.listRepositories.mockResolvedValue([{ repo: 'octo/demo', private: false }])
    mocks.registry.stub.createSession.mockResolvedValue(session({ id: 'created-session' }))
  })

  it('starts a session with the prompt and opens it', async () => {
    const { router } = await renderHome()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('What should Pi work on?')

    fireEvent.change(field(), { target: { value: '  Fix the flaky test in @octo/demo  ' } })
    fireEvent.submit(field().closest('form')!)

    await waitFor(() => expect(mocks.registry.stub.createSession).toHaveBeenCalledWith({ prompt: 'Fix the flaky test in @octo/demo' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions/created-session'))
  })

  it('starts the session on the model picked in the composer', async () => {
    mocks.registry.stub.listModels.mockResolvedValue([{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }])
    await renderHome()

    const picker = await screen.findByRole('combobox', { name: 'Model' })
    expect(field().closest('form')!.contains(picker)).toBe(true)
    await waitFor(() => expect(picker.textContent).toContain('Model A'))
    fireEvent.click(picker)
    const option = await screen.findByRole('option', { name: 'Model B' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    await waitFor(() => expect(picker.textContent).toContain('Model B'))

    fireEvent.change(field(), { target: { value: 'Add a README' } })
    fireEvent.submit(field().closest('form')!)
    await waitFor(() => expect(mocks.registry.stub.createSession).toHaveBeenCalledWith({ prompt: 'Add a README', model: 'model-b' }))
  })

  it('keeps the prompt and shows why a session could not start', async () => {
    mocks.registry.stub.createSession.mockRejectedValue(new Error('Registry unavailable'))
    const { router } = await renderHome()

    fireEvent.change(field(), { target: { value: 'Add a README' } })
    fireEvent.submit(field().closest('form')!)

    expect((await screen.findByRole('alert')).textContent).toContain('Registry unavailable')
    expect(field().value).toBe('Add a README')
    expect(field().disabled).toBe(false)
    expect(router.state.location.pathname).toBe('/')
  })

  it('fills a starter prompt and opens the repository picker after its @', async () => {
    await renderHome()

    fireEvent.click(screen.getByRole('button', { name: /Fix a bug/ }))

    await waitFor(() => expect(field().value).toBe('In @'))
    expect(await screen.findByRole('button', { name: /octo\/demo/ })).toBeTruthy()
    expect(mocks.registry.stub.listRepositories).toHaveBeenCalledTimes(1)
  })

  it('offers the repositories recent sessions worked on', async () => {
    mocks.registry.stub.listSessions.mockResolvedValue([
      session({ id: 'a', repo: 'octo/demo' }),
      session({ id: 'b', repo: 'octo/demo' }),
      session({ id: 'c', repo: 'octo/site' }),
      session({ id: 'd' }),
    ])
    await renderHome()

    const recent = await screen.findByRole('region', { name: 'Recent' })
    expect([...recent.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['octo/demo', 'octo/site'])

    fireEvent.change(field(), { target: { value: 'Compare' } })
    fireEvent.click(screen.getByRole('button', { name: 'octo/site' }))
    await waitFor(() => expect(field().value).toBe('Compare @octo/site '))
    // The caret moves on the next frame; waiting for it leaves no frame to run after the test.
    await waitFor(() => expect(document.activeElement).toBe(field()))
    expect(field().selectionStart).toBe('Compare @octo/site '.length)
  })
})
