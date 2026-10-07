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
- A singleton `PiRegistry` Durable Object keeps the session catalog with the Agents SDK's `RoutedAgents`, and is the only route to a session.
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

`BUCKET` is the app's R2 bucket, `pi-on-cf`. It is a remote binding, so local development reads the real bucket. Create it once with `npx wrangler r2 bucket create pi-on-cf`.

## Skills

Pi offers [Agent Skills](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/) from two sources: built-in skills in `src/server/bundled-skills`, which ship with the Worker, and shared skills under `skills/` in the bucket. Each skill is a directory holding a `SKILL.md` with `name` and `description` frontmatter, and optional `references/`, `scripts/` and `assets/`. A built-in skill wins a name, so a shared skill cannot replace one.

```bash
npx wrangler r2 object put pi-on-cf/skills/release-notes/SKILL.md --file SKILL.md --remote
```

Only each skill's name and description go into the system prompt. The model loads a skill's body with `activate_skill` and reads its files with `read_skill_resource`; skill scripts do not run. A session lists the bucket when it starts and again at most once a minute after a prompt, so new and changed skills reach running sessions without a deploy.

The agent manages shared skills too. The built-in `skill-creator` skill, adapted from Anthropic's [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) under the Apache License 2.0, teaches it to draft a skill in `/workspace/skills/<name>/` and publish it with `save_skill`. `open_skill` copies a shared skill into the workspace to edit, and `delete_skill` deletes one. Built-in skills cannot be changed.

A shared skill instructs every session, including its container with network access, and the agent saves skills without review. A session that follows injected instructions, from a web page or a repository, can save a skill that steers every other session. Anyone who can write to `skills/` in the bucket can do the same; restrict write access to it.

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
