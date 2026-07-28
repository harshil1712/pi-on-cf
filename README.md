# Pi on Cloudflare

A Worker-native experiment using Pi's portable agent loop, Cloudflare Durable Objects, AI Gateway, and a SQLite-backed workspace.

## Architecture

- `@earendil-works/pi-agent-core` runs Pi's model and tool loop.
- One `PiSession` Durable Object owns each transcript and workspace.
- `@cloudflare/shell` stores workspace files in Durable Object SQLite.
- AI requests use Cloudflare AI Gateway's OpenAI-compatible REST API.
- Cloudflare Agents SDK routes callable methods and streamed Pi events over WebSockets at `/api/agents/*`.
- TanStack Start renders the UI and handles requests that do not match an Agent route.
- Cloudflare Kumo provides accessible UI primitives while the application keeps its custom visual system.

The source is organized by runtime boundary:

- `src/shared` contains the browser-safe Agent contract.
- `src/server` contains the Durable Object, model setup, tools, and event translation.
- `src/features/workspace` contains transcript state, session orchestration, and the workspace UI.
- `src/routes` contains thin TanStack route entries.

The current tools are `read`, `write`, `edit`, `list`, `find`, and `grep`. This version does not provide native processes or a POSIX shell.

See [Pi Feature and Cloudflare Platform Audit](docs/pi-feature-audit.md) for a detailed comparison of the current application, upstream Pi, and relevant Cloudflare platform capabilities.

> This is a single-workspace prototype. Before deploying it publicly, protect the Worker with Cloudflare Access or another authentication layer. The API uses your server-side AI Gateway token and is intentionally not a public anonymous service.

## Local Development

Create `.env` from `.env.example`, then provide a Cloudflare API token with AI Gateway permissions and your account ID.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production

Configure the two runtime secrets before deploying:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npm run deploy
```

`AI_MODEL` and `AI_GATEWAY_ID` are non-secret variables in `wrangler.jsonc`.

## Verification

```bash
npm run generate-routes
npm run typecheck
npm test
npm run build
```
