import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '~/components/settings-page'

export const Route = createFileRoute('/settings')({
  // Where an MCP server's OAuth callback sends a failure.
  validateSearch: (search: Record<string, unknown>): { mcp_error?: string } => (typeof search.mcp_error === 'string' ? { mcp_error: search.mcp_error } : {}),
  component: SettingsRoute,
})

function SettingsRoute() {
  const { mcp_error: mcpError } = Route.useSearch()
  return <SettingsPage mcpError={mcpError} />
}
