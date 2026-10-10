import type { Browser } from 'agents/browser'
import { browserTool } from 'agents/browser/pi'
import { webFetchTool } from 'agents/webfetch/pi'
import { webSearchTool, type WebSearchProvider } from 'agents/websearch/pi'
import type { ToolRegistration } from '@earendil-works/pi-durable'

/**
 * The bindings the web tools use. The search variables are optional:
 * removing WEB_SEARCH_PROVIDER from wrangler.jsonc turns search off.
 */
export type WebToolsEnv = Pick<Env, 'AI' | 'AI_GATEWAY_ID' | 'LOADER'> & {
  WEB_SEARCH_PROVIDER?: WebSearchProvider
  WEB_SEARCH_BYOK_ALIAS?: string
}

/**
 * Pi's web tools for one session: `web_fetch` reads a page as Markdown,
 * `web_search` finds pages once `WEB_SEARCH_PROVIDER` is set (see README →
 * Web search), and `browser` drives the session's Chromium on Browser Run
 * when there is a `BROWSER` binding.
 */
export function createWebTools(env: WebToolsEnv, session: { ctx: DurableObjectState; browser?: Browser }): ToolRegistration[] {
  const tools: ToolRegistration[] = [webFetchTool({ binding: env.AI })]

  if (env.WEB_SEARCH_PROVIDER) {
    tools.push(webSearchTool({ binding: env.AI, gateway: env.AI_GATEWAY_ID, provider: env.WEB_SEARCH_PROVIDER, byokAlias: env.WEB_SEARCH_BYOK_ALIAS }))
  }

  if (session.browser) tools.push(browserTool({ ctx: session.ctx, browser: session.browser, loader: env.LOADER }))

  return tools
}

/** When to pick each web tool; what each does is in its own description. */
const GUIDANCE = new Map([
  ['web_fetch', 'web_fetch to read a page'],
  ['web_search', 'web_search to find one'],
  ['browser', 'browser only for pages that need JavaScript or interaction, or to see them'],
])

/** The preamble's line on the web tools the session has. */
export function webToolGuidance(tools: ToolRegistration[]): string[] {
  const uses = tools.flatMap((tool) => GUIDANCE.get(tool.name) ?? [])

  return uses.length ? [`- For the web, use ${uses.join('; ')}. Do not curl from the container, which gets only raw HTML.`] : []
}
