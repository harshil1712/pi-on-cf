import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '~/components/settings-page'
import { isString } from '~/lib/json'

/** The page's search: where an MCP server's OAuth callback sends a failure. */
type SettingsSearch = { mcp_error?: string }

export const Route = createFileRoute('/settings')({
  validateSearch: ({ mcp_error }): SettingsSearch => (isString(mcp_error) ? { mcp_error } : {}),
  component: SettingsRoute,
})

function SettingsRoute() {
  const { mcp_error: mcpError } = Route.useSearch()

  return <SettingsPage mcpError={mcpError} />
}
