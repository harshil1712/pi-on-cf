# Before M3: browser and MCP tools

Two capabilities before the async loop: Pi can use the web like a person (read pages, drive a browser), and Pi can use tools from MCP servers you connect once. This plan builds on `main` at `112c788`, after the mobile-first UI (PR #2) landed.

## Order

| # | Step | Depends on | Size |
|---|---|---|---|
| 0 | Upgrade `agents` 0.26 → 0.28 | — | S |
| 1 | `web_fetch` and `browser` tools | 0 | M |
| 2 | Live View and screenshots in the app | 1 | S–M |
| 3 | MCP servers on the registry | 0 | M |
| 4 | MCP tools in every session | 3 | M |
| — | Browser reaches the container's dev server | later | M |

Each step ships on its own: tests, `npm run check`, a browser check, then a commit.

---

## 0. Upgrade `agents` to 0.28

0.28 ships pi-durable adapters we would otherwise write: `browserTool` (`agents/browser/pi`), `webFetchTool` (`agents/webfetch/pi`) and `webSearchTool` (`agents/websearch/pi`). It also marks `MCPClientManager` (`agents/mcp/client`) stable.

- Breaking changes between 0.26 and 0.28 touch only `agents/channels` (moved to `agents/experimental/channels`), which the app doesn't use.
- Check `PiHarness`, `RoutedAgents` and `createAI` against the current code; `npm run check` is the gate.
- Bump `@cloudflare/codemode` to what 0.28 peers on.

---

## 1. `web_fetch` and `browser`

**Why both:** `web_fetch` is cheap and read-only (fetch, then Markdown through `env.AI.toMarkdown()`), right for docs, READMEs, API references and changelogs. `browser` is a real Chromium on Browser Run that Pi drives with CDP from code, right for pages that need JavaScript, clicks, logins or screenshots. Today Pi can only `curl` from the container, which gets raw HTML.

**Config**
- `"browser": { "binding": "BROWSER", "remote": true }` in `wrangler.jsonc`, and in `previews`.
- `export { CodemodeRuntime } from '@cloudflare/codemode'` from `src/server.ts`: the browser tool's codemode runtime is a facet of the session's Durable Object.
- `LOADER` already exists.

**Server** (`src/server/pi-session.ts`)
- `readonly browser = new Browser({ provider: browserRun(this.env.BROWSER, { keepAliveMs }) })`, used on the Lifecycle before the harness, so it's disposed after.
- A `web` extension installs `webFetchTool({ binding: this.env.AI })` and `browserTool({ ctx: this.ctx, browser: this.browser, loader: this.env.LOADER })`.
  - `web_fetch` is `replay: 'safe'`; `browser` is not rerun after an eviction (the SDK's choice; its code may have clicked something).
  - pi only sends screenshots to models that accept images; others get the text.
- Teardown closes the browser, beside the container.
- The preamble says when to use which: `web_fetch` to read, `browser` to interact or see, container `curl` only for raw API calls.

**Optional:** `webSearchTool({ binding: this.env.AI, gateway: this.env.AI_GATEWAY_ID })`. Each search is billed through the AI Gateway, so it's behind a var (`WEB_SEARCH_PROVIDER`), off by default.

**Limits**
- **The browser can't reach the container.** Browser Run is on the public internet, so `http://localhost:5173` in the container is out of reach. Pi can test deployed URLs (a Worker Preview, for example) but not its own dev server yet. See [Later](#later-the-browser-reaches-the-containers-dev-server).
- Pages are untrusted content: a page can prompt-inject Pi, which has a container with network access and a GitHub token for one repo. That's the same exposure as `curl` today, but a real browser makes it easier.
- Browser Run bills per browser hour; `keepAliveMs` caps an idle browser.

**Tests**
- Worker test: the session's registry offers `web_fetch` and `browser` when `BROWSER` is bound, and not without it (test wrangler config has no binding).
- `web_fetch` against a stubbed `fetch`, through pi's faux model, to check the extension is wired.
- No live Browser Run in tests; check that by hand.

---

## 2. Live View and screenshots

**Live View:** a "Browser" button in the session's top bar, shown once the session has a browser, opens Browser Run's Live View of Pi's tab in a new tab. You can watch Pi, or take over to log in or solve a CAPTCHA, then tell Pi to carry on. Cookies stay in that session's browser.
- `@callable() liveView()` returns `this.browser.liveView()` (URLs last about five minutes, so fetch one on click).
- On phones it sits in the same top bar; Live View works in mobile browsers.

**Screenshots:** the transcript reducer keeps image parts of tool results, and the activity card shows them as thumbnails that open full size. Today `src/lib/transcript.ts` drops them.

**Tests:** unit tests for the reducer keeping images and the card rendering them, and for the button calling `liveView`.

---

## 3. MCP servers on the registry

**Where they live:** on `PiRegistry`, so you connect a server once and every session can use it. `PiRegistry` is an `Agent`, so it already has `this.mcp` (`MCPClientManager`), which keeps servers, OAuth tokens and headers in its SQLite and reconnects after a wake. Per-session OAuth would mean authorizing every server in every session.

**Callables** (on the registry)
- `listMcpServers()`: name, URL, state (`ready`, `authenticating`, `failed`…), error, tool count, `enabled`. Never returns headers.
- `addMcpServer({ name, url, headers? })`: `this.addMcpServer(...)`. Returns `authUrl` when the server needs OAuth.
- `removeMcpServer(id)`, `reconnectMcpServer(id)`, `setMcpServerEnabled(id, enabled)`. `enabled` lives in the registry's own table, since the SDK has no such flag.
- Each change bumps the revision, so open pages update.

**OAuth**
- The callback is the registry's route, `/api/agents/pi-registry/singleton/callback`. You open the auth URL in your own browser, which has the Access cookie, so no Access bypass is needed.
- `configureOAuthCallback({ customHandler })` answers with a page that closes itself (popup) or redirects to `/settings` (phones, where popups are awkward).
- Server URLs go through the SDK's SSRF check, which blocks private ranges.

**UI:** a `/settings` page, linked from the sidebar footer, with a Connections section: add a server (name, URL, optional header such as `Authorization`), each server's state and tool count, Connect (for OAuth), Enable, Remove. Mobile-first like the rest.

**Tests:** worker tests against a test MCP server bound over the SDK's RPC transport (an `McpAgent` in `test/worker/entry.ts`): add, list, remove, `enabled`, state changes bump the revision, headers never come back.

---

## 4. MCP tools in every session

**Shape:** `PiSession` installs an `mcp` extension built from the registry's catalog. pi's `registry.install` replaces an extension by name in place, so the session reinstalls it when the catalog changes, as `SkillCatalog` does for skills.

- `registry.listMcpTools()` returns tools from enabled, ready servers, with a fingerprint.
- The session fetches it when the harness opens and after each accepted prompt (in the background, like `#syncSkills`), and reinstalls only when the fingerprint moved. A new server reaches a running session from its next model request.
- Tool names: `mcp_<server>_<tool>`, sanitized to `[a-zA-Z0-9_-]` and 64 characters, made unique. Descriptions say which server a tool is from.
- Parameters: the tool's JSON Schema as is (pi validates with TypeBox, which accepts it, as for Computer's tools).
- `execute` calls `registry.callMcpTool(serverId, name, args)` over RPC, so credentials never leave the registry. Text and image content map to pi content; resources become text; `isError` carries over.
- Replay: `safe` only when the server marks the tool `readOnlyHint` (or `idempotentHint`); otherwise pi reports an interrupted call instead of running it again.
- A `mcp` prompt section lists connected servers and their `instructions`, and says that results are untrusted content.

**Context size:** some servers expose dozens of tools. Per-server `enabled` is the first control. If that isn't enough, a later step can expose MCP through one codemode tool (search, then call) instead of a tool per MCP tool.

**Security:** MCP tools act with your credentials, and their results can carry injected instructions. Any session can call any enabled server, the way any session can push to any installed repo. The architecture doc's Security Model gets a paragraph.

**Tests:** a session's model sees the test server's tools, calls one, and gets its result; a disabled server's tools disappear on the next prompt; a non-read-only tool isn't rerun after a simulated interruption.

---

## Later: the browser reaches the container's dev server

Pi can't yet open the app it's building. Options, roughly in order of preference:

1. **Proxy through the session.** The browser's requests for `localhost:<port>` are intercepted with CDP's `Fetch` domain and fulfilled with `container.fetchPort(port, request)`. Nothing is exposed publicly, but every request round-trips through the Durable Object, and WebSockets (HMR) don't work.
2. **A preview route.** `/sessions/:id/preview/:port/*` proxies to `container.port(port)`. You can open it too, behind Access. Browser Run can't pass Access, so the route would need a per-session secret in the URL, which means an Access bypass for that path.
3. **Chromium in the container** (Playwright). It reaches localhost directly, but makes the image much larger and has no Live View.

## Open questions

1. MCP: one set of servers shared by every session (recommended), or choose servers per session?
2. Turn on `web_search` (billed through AI Gateway), or only `web_fetch` and `browser` for now?
3. Is reaching the container's dev server needed before M3, or later?
4. Where should MCP settings live: a `/settings` page (recommended) or a dialog from the sidebar?
