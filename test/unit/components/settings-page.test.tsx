import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSummary } from '~/contract'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
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
  onMcpUpdate: undefined as undefined | ((state: unknown) => void),
}))

vi.mock('agents/react', () => ({
  useAgent: (options: { onMcpUpdate?: (state: unknown) => void }) => {
    mocks.onMcpUpdate = options.onMcpUpdate
    return mocks.useAgent(options)
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

import { act } from 'react'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { SessionRegistryProvider } from '~/hooks/use-session-registry'
import { SettingsPage } from '~/components/settings-page'

const server = (overrides: Partial<McpServerSummary> = {}): McpServerSummary => ({
  id: 'docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', state: 'ready', toolCount: 2, enabled: true, ...overrides,
})

function renderSettings(mcpError?: string) {
  return render(<Sidebar.Provider><SessionRegistryProvider><SettingsPage mcpError={mcpError} /></SessionRegistryProvider></Sidebar.Provider>)
}

describe('SettingsPage', () => {
  const assign = vi.fn()

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockReturnValue(mocks.registry)
    mocks.navigate.mockResolvedValue(undefined)
    mocks.registry.stub.listSessions.mockResolvedValue([])
    mocks.registry.stub.listMcpServers.mockResolvedValue([])
    vi.spyOn(window, 'location', 'get').mockReturnValue({ assign } as unknown as Location)
  })

  it('lists servers with their state and tool count', async () => {
    mocks.registry.stub.listMcpServers.mockResolvedValue([server(), server({ id: 'cf', name: 'Cloudflare API', state: 'authenticating', toolCount: 0 })])
    renderSettings()
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
    renderSettings()
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
    renderSettings()
    await screen.findByText('No servers yet')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'API' } })
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mcp.cloudflare.com/mcp' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add server' }).closest('form')!)

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example.com/authorize'))
    expect(mocks.registry.stub.connectMcpServer).toHaveBeenCalledWith({ name: 'API', url: 'https://mcp.cloudflare.com/mcp' })
  })

  it('shows why a server could not be added', async () => {
    mocks.registry.stub.connectMcpServer.mockRejectedValue(new Error('MCP server URLs must use https.'))
    renderSettings()
    await screen.findByText('No servers yet')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A' } })
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://example.com/mcp' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add server' }).closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toContain('MCP server URLs must use https.')
  })

  it('turns a server off for sessions', async () => {
    mocks.registry.stub.listMcpServers.mockResolvedValue([server()])
    mocks.registry.stub.setMcpServerEnabled.mockResolvedValue(server({ enabled: false }))
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Use Cloudflare Docs in sessions' })
    fireEvent.click(toggle)
    await waitFor(() => expect(mocks.registry.stub.setMcpServerEnabled).toHaveBeenCalledWith('docs', false))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('removes a server after confirming', async () => {
    mocks.registry.stub.listMcpServers.mockResolvedValue([server()])
    mocks.registry.stub.deleteMcpServer.mockResolvedValue(undefined)
    renderSettings()
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
    renderSettings()
    await screen.findByText('No servers yet')
    mocks.registry.stub.listMcpServers.mockResolvedValue([server()])
    act(() => mocks.onMcpUpdate?.({ servers: {}, tools: [], prompts: [], resources: [] }))
    expect((await screen.findByRole('list', { name: 'MCP servers' })).textContent).toContain('Cloudflare Docs')
  })

  it('shows an OAuth failure from the callback, then drops it from the URL', async () => {
    renderSettings('access_denied')
    expect((await screen.findByRole('alert')).textContent).toContain('Authorization failed: access_denied')
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings', search: {}, replace: true })
  })
})
