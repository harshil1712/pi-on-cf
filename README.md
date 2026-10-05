# Pi on Cloudflare

A Worker-native coding agent: Pi's durable harness running inside Cloudflare Durable Objects, with a Cloudflare Computer workspace per session.

> [!WARNING]
> This is a single-user prototype with no application-level authentication or authorization. Anyone who can reach a deployment can use its AI binding and read, change, or delete its sessions and workspace files. Do not expose it to the public Internet without protecting the entire Worker with Cloudflare Access or another authentication layer.

## Architecture

- `@earendil-works/pi-durable` runs Pi: the transcript, the steer/follow-up inbox, generation, tool calls, retries, compaction, and crash recovery, all committed to the Durable Object's SQLite.
- `agents/harness/pi` (`PiHarness`) hosts pi-durable in the `PiSession` Durable Object and wakes it through the Agents SDK Lifecycle after eviction.
- `agents/models/pi-ai` (`createAI`) gives Pi Workers AI and AI Gateway over the `AI` binding.
- `@cloudflare/computer` provides the durable workspace at `/workspace`, with Worker Shell, Worker JavaScript, and a Durable Object-scheduled Linux container as `exec` backends. Its `createPiTools` supplies the model's tools.
- Pi's agent events stream to the browser over the Agents SDK WebSocket: a snapshot on connect, then one batch per commit.
- A singleton `PiRegistry` Durable Object keeps the session catalog.
- TanStack Start renders the UI; Cloudflare Kumo provides UI primitives.

The source is organized by runtime boundary:

- `src/shared` contains the browser-safe contract.
- `src/server` contains the Durable Objects and the Computer tool adapter.
- `src/features` contains the session catalog, the transcript reducer, and the workspace UI.
- `src/routes` contains thin TanStack route entries.

See [Pi on Cloudflare Architecture](docs/architecture.md) for the system design.

## Local Development

Local development needs Docker for the Computer container and a `wrangler login` for the remote `AI` and Artifacts bindings. Local Durable Object state is written to `.wrangler/` and may contain transcripts and workspace files.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Configuration

`AI_MODEL` selects the model new sessions start with; `AI_GATEWAY_ID` selects the AI Gateway. Both are non-secret variables in `wrangler.jsonc`. The shared file keeps the neutral gateway ID `default`; keep account-specific configuration in an ignored `wrangler.local.jsonc` and select it with `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.local.jsonc` for Vite commands or `--config wrangler.local.jsonc` for Wrangler.

`Dockerfile.computer` pins the `computerd` image; keep its version in step with `@cloudflare/computer`.

`compatibility_date` is the newest date the bundled workerd supports. `package.json` overrides the `miniflare` and `wrangler` that `@cloudflare/vitest-pool-workers` pins, so dev, tests, and deploys share one runtime. Bump the date together with Wrangler, and drop the override once the pool ships a matching Miniflare.

## Production

Protect the entire Worker with Cloudflare Access or another authentication layer before deploying. The application does not enforce this itself.

```bash
npm run deploy
```

Do not publish the working directory as an archive. Publish from a clean clone so ignored `.wrangler`, `dist`, and `node_modules` content cannot be included accidentally.

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
