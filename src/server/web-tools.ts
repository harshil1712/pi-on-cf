import type { Browser } from 'agents/browser'
import { browserTool } from 'agents/browser/pi'
import { webFetchTool } from 'agents/webfetch/pi'
import { webSearchTool, type WebSearchProvider } from 'agents/websearch/pi'
import type { ToolRegistration } from '@earendil-works/pi-durable'

/**
 * Plain vars are typed in worker-configuration.d.ts only when wrangler.jsonc
 * declares them, and the web-search ones are off by default: read them as
 * unknowns. Search is on once both are set (see README → Web search).
 */
function searchVars(env: Env): { provider?: WebSearchProvider; alias?: string } {
  const vars = env as unknown as Record<string, string | undefined>
  const provider = vars.WEB_SEARCH_PROVIDER
  return {
    provider: provider === 'ceramic' || provider === 'exa' || provider === 'linkup' ? provider : undefined,
    alias: vars.WEB_SEARCH_BYOK_ALIAS,
  }
}

/**
 * Pi's web tools for one session: `web_fetch` reads a page as Markdown,
 * `web_search` finds pages, and `browser` drives a real Chromium on Browser
 * Run for pages that need JavaScript, clicks, logins or screenshots. Each
 * exists only with what it needs, so a deployment (or a test environment)
 * without a binding or a var just gets a shorter list.
 */
export function createWebTools(env: Env, session: { ctx: DurableObjectState; browser?: Browser }): ToolRegistration[] {
  const tools: ToolRegistration[] = []
  if (env.AI) {
    tools.push(webFetchTool({ binding: env.AI }))
    const { provider, alias } = searchVars(env)
    if (provider && alias) {
      tools.push(webSearchTool({ binding: env.AI, gateway: env.AI_GATEWAY_ID || 'default', provider, byokAlias: alias }))
    }
  }
  if (session.browser) tools.push(browserTool({ ctx: session.ctx, browser: session.browser, loader: env.LOADER }))
  return tools
}

/**
 * The preamble's guidance on the web tools the session actually has, or an
 * empty string when it has none.
 */
export function webToolGuidance(env: Env): string[] {
  const tools = []
  if (env.AI) tools.push('web_fetch to read a page as readable Markdown')
  if (env.AI && searchVars(env).provider) tools.push('web_search to find a page first')
  if (env.BROWSER) tools.push('browser for pages that need JavaScript, to interact with them, or to look at them')
  if (tools.length === 0) return []
  return [`For the web, use ${tools.join('; ')}. Prefer these to curl in the container, which gets raw HTML.`]
}
