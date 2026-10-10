import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { UseAgentOptions } from 'agents/react'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import type { McpServerSummary, PiRegistryState } from '~/contract'
import { AgentConnectionProvider } from '~/hooks/use-agent-connection'
import { SessionRegistryProvider } from '~/hooks/use-session-registry'
import { SettingsPage } from '~/components/settings-page'
import { renderAtPath } from '../render-at-path'

type RegistryOptions = UseAgentOptions<PiRegistryState>

const mocks = {
  registry: {
    stub: {
      listSessions: vi.fn(),
      listMcpServers: vi.fn(),
      connectMcpServer: vi.fn(),
      reconnectMcpServer: vi.fn(),
      setMcpServerEnabled: vi.fn(),
      deleteMcpServer: vi.fn(),
    },
  },
  useAgent: vi.fn(),
  onMcpUpdate: undefined as RegistryOptions['onMcpUpdate'],
}

const server = (overrides: Partial<McpServerSummary> = {}): McpServerSummary => ({
  id: 'docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', state: 'ready', toolCount: 2, enabled: true, ...overrides,
})

/** The app's providers, over a fake registry connection. */
function Providers({ children }: { children: ReactNode }) {
  return <AgentConnectionProvider value={mocks.useAgent}><Sidebar.Provider><SessionRegistryProvider>{children}</SessionRegistryProvider></Sidebar.Provider></AgentConnectionProvider>
}

function renderSettings(mcpError?: string) {
  const path = mcpError ? `/settings?mcp_error=${encodeURIComponent(mcpError)}` : '/settings'

  return renderAtPath(<SettingsPage mcpError={mcpError} />, { path, wrapper: Providers })
}

describe('SettingsPage', () => {
  const assign = vi.fn()

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockImplementation((options: RegistryOptions) => {
      mocks.onMcpUpdate = options.onMcpUpdate

      return mocks.registry
    })
    mocks.registry.stub.listSessions.mockResolvedValue([])
    mocks.registry.stub.listMcpServers.mockResolvedValue([])
    // jsdom's location cannot be spied on; this one records where the page sends the browser.
    const { ancestorOrigins, href } = window.location
    vi.spyOn(window, 'location', 'get').mockReturnValue(Object.assign(new URL(href), { ancestorOrigins, assign, reload: vi.fn(), replace: vi.fn() }))
  })

  it('lists servers with their state and tool count', async () => {
    mocks.registry.stub.listMcpServers.mockResolvedValue([server(), server({ id: 'cf', name: 'Cloudflare API', state: 'authenticating', toolCount: 0 })])
    await renderSettings()
    const list = await screen.findByRole('list', { name: 'MCP servers' })
    const [docs, api] = within(list).getAllByRole('listitem')
    expect(docs!.textContent).toContain('Cloudflare Docs')
    expect(docs!.textContent).toContain('Connected')
    expect(docs!.textContent).toContain('2 tools')
    expect(api!.textContent).toContain('Needs authorization')
    expect(within(api!).getByRole('button', { name: 'Authorize' })).toBeTruthy()
  })

  it('adds a server with a header and shows it', async () => {
    mocks.registry.stub.connectMcpServer.mockResolvedValue({ server: server() })
    await renderSettings()
    await screen.findByText('No servers yet')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cloudflare Docs' } })
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://docs.mcp.cloudflare.com/mcp' } })
    fireEvent.change(screen.getByPlaceholderText('Authorization'), { target: { value: 'Authorization' } })
    fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'Bearer secret' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add server' }).closest('form')!)

    await waitFor(() => expect(mocks.registry.stub.connectMcpServer).toHaveBeenCalledWith({
      name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', headers: { Authorization: 'Bearer secret' },
    }))
    expect((await screen.findByRole('list', { name: 'MCP servers' })).textContent).toContain('Cloudflare Docs')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
  })

  it('continues to the authorization page when a server wants OAuth', async () => {
    mocks.registry.stub.connectMcpServer.mockResolvedValue({ server: server({ state: 'authenticating' }), authUrl: 'https://auth.example.com/authorize' })
    await renderSettings()
    await screen.findByText('No servers yet')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'API' } })
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mcp.cloudflare.com/mcp' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add server' }).closest('form')!)

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example.com/authorize'))
    expect(mocks.registry.stub.connectMcpServer).toHaveBeenCalledWith({ name: 'API', url: 'https://mcp.cloudflare.com/mcp' })
  })

  it('shows why a server could not be added', async () => {
    mocks.registry.stub.connectMcpServer.mockRejectedValue(new Error('MCP server URLs must use https.'))
    await renderSettings()
    await screen.findByText('No servers yet')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A' } })
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://example.com/mcp' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add server' }).closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toContain('MCP server URLs must use https.')
  })

  it('turns a server off for sessions', async () => {
    mocks.registry.stub.listMcpServers.mockResolvedValue([server()])
    mocks.registry.stub.setMcpServerEnabled.mockResolvedValue(server({ enabled: false }))
    await renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Use Cloudflare Docs in sessions' })
    fireEvent.click(toggle)
    await waitFor(() => expect(mocks.registry.stub.setMcpServerEnabled).toHaveBeenCalledWith('docs', false))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('removes a server after confirming', async () => {
    mocks.registry.stub.listMcpServers.mockResolvedValue([server()])
    mocks.registry.stub.deleteMcpServer.mockResolvedValue(undefined)
    await renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(dialog.textContent).toContain("Cloudflare Docs's tools")
    await waitFor(() => expect(mocks.registry.stub.deleteMcpServer).toHaveBeenCalledWith('docs'))

    // The dialog keeps naming the server while it closes.
    if (screen.queryByRole('alertdialog')) expect(screen.getByRole('alertdialog').textContent).toContain("Cloudflare Docs's tools")
    expect(await screen.findByText('No servers yet')).toBeTruthy()
  })

  it('reloads the servers when the SDK reports a change', async () => {
    await renderSettings()
    await screen.findByText('No servers yet')
    mocks.registry.stub.listMcpServers.mockResolvedValue([server()])
    act(() => mocks.onMcpUpdate?.({ servers: {}, tools: [], prompts: [], resources: [] }))
    expect((await screen.findByRole('list', { name: 'MCP servers' })).textContent).toContain('Cloudflare Docs')
  })

  it('shows an OAuth failure from the callback, then drops it from the URL', async () => {
    const { router } = await renderSettings('access_denied')
    expect((await screen.findByRole('alert')).textContent).toContain('Authorization failed: access_denied')
    await waitFor(() => expect(router.state.location.searchStr).toBe(''))
    expect(router.state.location.pathname).toBe('/settings')
    expect(router.history.length).toBe(1)
  })
})
