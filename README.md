# Pi on Cloudflare

A Worker-native experiment using Pi's portable agent loop, Cloudflare Durable Objects, AI Gateway, and a SQLite-backed workspace.

> [!WARNING]
> This is a single-user prototype with no application-level authentication or authorization. Anyone who can reach a deployment can use its server-side AI credentials and read, change, or delete its sessions and workspace files. Do not expose it to the public Internet without protecting the entire Worker with Cloudflare Access or another authentication layer.

## Architecture

- `@earendil-works/pi-agent-core` runs Pi's model and tool loop.
- One `PiSession` Durable Object owns each transcript and workspace.
- `@cloudflare/computer` stores workspace files in Durable Object SQLite and runs a just-bash shell in a Dynamic Worker.
- AI requests use Cloudflare AI Gateway's OpenAI-compatible REST API.
- Cloudflare Agents SDK routes callable methods and streamed Pi events over WebSockets at `/api/agents/*`.
- TanStack Start renders the UI and handles requests that do not match an Agent route.
- Cloudflare Kumo provides accessible UI primitives while the application keeps its custom visual system.

The source is organized by runtime boundary:

- `src/shared` contains the browser-safe Agent contract.
- `src/server` contains the Durable Object, model setup, tools, and event translation.
- `src/features/workspace` contains transcript state, session orchestration, and the workspace UI.
- `src/routes` contains thin TanStack route entries.

The current tools are `read`, `write`, `edit`, `list`, `find`, `grep`, and `exec`. Computer's Worker backend supports common shell text utilities and Git, but not native processes such as Node.js, npm, or Python.

See [Pi on Cloudflare Architecture](docs/architecture.md) for the current system design, and [Pi Feature and Cloudflare Platform Audit](docs/pi-feature-audit.md) for upstream Pi feature and platform research with implementation ideas.

## Local Development

Create `.env` from `.env.example`, then provide a Cloudflare API token with AI Gateway permissions and your account ID. Local Durable Object state is written to `.wrangler/` and may contain transcripts, learned memory, and workspace files.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Configuration

The shared `wrangler.jsonc` intentionally uses the neutral AI Gateway ID `default`. Keep account-specific Gateway IDs out of that file. `wrangler.local.jsonc` is not a special Wrangler filename; it is an ignored copy that can be selected explicitly. For Vite commands, including this project's development, build, and deploy scripts, set `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.local.jsonc`. For direct Wrangler commands, pass `--config wrangler.local.jsonc`.

`AI_MODEL` and `AI_MEMORY_MODEL` select the primary and memory-extraction models. They are non-secret variables in `wrangler.jsonc`.

## Production

Protect the entire Worker with Cloudflare Access or another authentication layer before deploying. The application does not enforce this itself.

Configure the two runtime secrets before deploying:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npm run deploy
```

Do not publish the working directory as an archive. Publish from a clean clone or through normal Git operations so ignored `.env`, `.wrangler`, `dist`, and `node_modules` content cannot be included accidentally.

## Verification

```bash
npm run generate-routes
npm run lint
npm run typecheck
npm test
npm run build
```

## License

Licensed under the [MIT License](LICENSE).
