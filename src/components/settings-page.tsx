import { useCallback, useEffect, useState, type SubmitEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Badge, type BadgeVariant } from '@cloudflare/kumo/components/badge'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Input } from '@cloudflare/kumo/components/input'
import { Switch } from '@cloudflare/kumo/components/switch'
import { PlugsConnectedIcon } from '@phosphor-icons/react'
import type { ConnectMcpServerInput, ConnectMcpServerResult, McpServerState, McpServerSummary } from '~/contract'
import { useSessionRegistry } from '~/hooks/use-session-registry'
import { TopBar } from './top-bar'
import { errorMessage } from '~/lib/error-message'

const STATES: Record<McpServerState, { label: string; variant: BadgeVariant }> = {
  ready: { label: 'Connected', variant: 'success' },
  authenticating: { label: 'Needs authorization', variant: 'warning' },
  connecting: { label: 'Connecting', variant: 'neutral' },
  connected: { label: 'Connecting', variant: 'neutral' },
  discovering: { label: 'Connecting', variant: 'neutral' },
  failed: { label: 'Failed', variant: 'error' },
  'not-connected': { label: 'Not connected', variant: 'neutral' },
}

/** App settings: for now, the MCP servers every session can use. */
export function SettingsPage({ mcpError }: { mcpError?: string }) {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const [servers, setServers] = useState<McpServerSummary[] | null>(null)
  const [error, setError] = useState(mcpError ? `Authorization failed: ${mcpError}` : '')
  const [busy, setBusy] = useState<string | null>(null)
  // Keeps the server while the dialog animates closed.
  const [removing, setRemoving] = useState<{ server: McpServerSummary; open: boolean } | null>(null)

  // Reload whenever the SDK reports a connection change.
  const { mcpRevision } = registry
  useEffect(() => {
    let ignore = false
    registry.agent.stub.listMcpServers().then((list) => { if (!ignore) setServers(list) }, (cause: unknown) => { if (!ignore) setError(errorMessage(cause)) })

    return () => { ignore = true }
  }, [registry.agent.stub, mcpRevision])

  // Drop the error from the URL, so a reload doesn't show it again.
  useEffect(() => {
    if (mcpError) void navigate({ to: '/settings', search: {}, replace: true })
  }, [mcpError, navigate])

  const update = useCallback((server: McpServerSummary) => {
    setServers((current) => current && (current.some((entry) => entry.id === server.id) ? current.map((entry) => (entry.id === server.id ? server : entry)) : [...current, server]))
  }, [])

  /** Run an action on a server; one that answers with an `authUrl` continues in this tab. */
  async function act(key: string, operation: () => Promise<ConnectMcpServerResult | McpServerSummary | void>): Promise<boolean> {
    setBusy(key)
    setError('')

    try {
      const result = await operation()

      if (result && 'authUrl' in result && result.authUrl) {
        window.location.assign(result.authUrl)

        return true
      }

      if (result) update('server' in result ? result.server : result)

      return true
    } catch (caught) {
      setError(errorMessage(caught))

      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <TopBar><h1 className="font-semibold">Settings</h1></TopBar>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
          <section aria-labelledby="mcp-heading" className="flex flex-col gap-4">
            <div>
              <h2 id="mcp-heading" className="text-lg font-semibold">MCP servers</h2>
              <p className="text-sm text-kumo-subtle">
                Every session can use the tools of enabled servers, with the credentials you connect them with.
                What a server returns can contain instructions, so connect only servers you trust.
              </p>
            </div>
            {error && <Banner variant="error" role="alert" description={error} />}
            {servers === null ? null : servers.length === 0 ? (
              <Empty size="sm" icon={<PlugsConnectedIcon size={32} className="text-kumo-inactive" />} title="No servers yet" description="Add one below, such as https://docs.mcp.cloudflare.com/mcp." />
            ) : (
              <ul className="flex flex-col gap-2" aria-label="MCP servers">
                {servers.map((server) => (
                  <ServerRow
                    key={server.id}
                    server={server}
                    busy={busy === server.id}
                    onConnect={() => void act(server.id, () => registry.agent.stub.reconnectMcpServer(server.id))}
                    onEnabledChange={(enabled) => void act(server.id, () => registry.agent.stub.setMcpServerEnabled(server.id, enabled))}
                    onRemove={() => setRemoving({ server, open: true })}
                  />
                ))}
              </ul>
            )}
            <AddServerForm
              busy={busy === 'add'}
              onAdd={(input) => act('add', () => registry.agent.stub.connectMcpServer(input))}
            />
          </section>
        </div>
      </main>
      <RemoveServerDialog
        server={removing?.server ?? null}
        open={removing?.open ?? false}
        onOpenChange={(open) => { if (!open) setRemoving((current) => current && { ...current, open: false }) }}
        onRemove={(server) => {
          setRemoving((current) => current && { ...current, open: false })
          void act(server.id, async () => {
            await registry.agent.stub.deleteMcpServer(server.id)
            setServers((current) => current && current.filter((entry) => entry.id !== server.id))
          })
        }}
      />
    </>
  )
}

function ServerRow({ server, busy, onConnect, onEnabledChange, onRemove }: {
  server: McpServerSummary
  busy: boolean
  onConnect: () => void
  onEnabledChange: (enabled: boolean) => void
  onRemove: () => void
}) {
  const state = STATES[server.state]
  const canConnect = server.state === 'authenticating' || server.state === 'failed' || server.state === 'not-connected'

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-kumo-hairline bg-kumo-base p-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{server.name}</span>
            <Badge variant={state.variant} appearance="dot">{state.label}</Badge>
          </div>
          <span className="truncate text-sm text-kumo-subtle" title={server.url}>{server.url}</span>
          <span className="text-xs text-kumo-subtle">
            {server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}
          </span>
        </div>
        <Switch
          size="sm"
          checked={server.enabled}
          disabled={busy}
          aria-label={`Use ${server.name} in sessions`}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {server.error && server.state === 'failed' && <p className="text-sm break-words text-kumo-danger">{server.error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {canConnect && (
          <Button size="sm" variant={server.state === 'authenticating' ? 'primary' : 'secondary'} loading={busy} onClick={onConnect}>
            {server.state === 'authenticating' ? 'Authorize' : 'Reconnect'}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>Remove</Button>
      </div>
    </li>
  )
}

/** Name, URL, and one optional header, such as `Authorization: Bearer <token>`. */
function AddServerForm({ busy, onAdd }: { busy: boolean; onAdd: (input: ConnectMcpServerInput) => Promise<boolean> }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [headerName, setHeaderName] = useState('')
  const [headerValue, setHeaderValue] = useState('')

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const header = headerName.trim()
    const added = await onAdd({ name, url, ...(header ? { headers: { [header]: headerValue } } : {}) })

    if (added) {
      setName('')
      setUrl('')
      setHeaderName('')
      setHeaderValue('')
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline bg-kumo-base p-4" aria-labelledby="add-mcp-heading">
      <h3 id="add-mcp-heading" className="font-medium">Add a server</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Cloudflare Docs" maxLength={60} required />
        <Input label="URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.mcp.cloudflare.com/mcp" required />
        <Input label="Header" value={headerName} onChange={(event) => setHeaderName(event.target.value)} placeholder="Authorization" autoComplete="off" required={false} />
        <Input label="Header value" type="password" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} placeholder="Bearer …" autoComplete="off" required={Boolean(headerName.trim())} />
      </div>
      <p className="text-xs text-kumo-subtle">Without a header, a server that needs authorization sends you to sign in.</p>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>Add server</Button>
      </div>
    </form>
  )
}

function RemoveServerDialog({ server, open, onOpenChange, onRemove }: { server: McpServerSummary | null; open: boolean; onOpenChange: (open: boolean) => void; onRemove: (server: McpServerSummary) => void }) {
  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="flex flex-col gap-3 p-6">
        <Dialog.Title className="text-lg font-semibold">Remove server?</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          Sessions will no longer have {server?.name}'s tools, and its credentials will be deleted.
        </Dialog.Description>
        <div className="mt-3 flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props} variant="secondary">Cancel</Button>} />
          <Button variant="destructive" onClick={() => server && onRemove(server)}>Remove</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
