# Pi on Cloudflare

Pi on Cloudflare is a Worker-native cloud coding agent: Pi's durable harness (`@earendil-works/pi-durable`) runs inside Cloudflare Durable Objects, with a Cloudflare Computer workspace per session, Workers AI through the `AI` binding, and a GitHub App for clones, pushes, and pull requests. TanStack Start renders the UI from Kumo components.

Read `docs/architecture.md` for the full system design before changing anything in `src/server/`, and the README for deployment, the GitHub App, and web tool configuration. This file is the day-to-day guide; those are the source of truth.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install. Node >= 22 (`.node-version`). |
| `npm run dev` | Vite dev server on `http://localhost:3000`. |
| `npm run check` | Lint, typecheck, and both test projects — what CI runs, run it before finishing. |
| `npm run lint` | `oxlint --deny-warnings`; warnings fail the build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | `vitest run`, both projects. |
| `npm run test:unit` / `test:worker` | One project: browser units (jsdom) / Worker tests (workerd). |
| `npm run build` | `vite build`. |
| `npm run deploy` | Build, then `wrangler deploy`. Fails until every GitHub App secret is set. |
| `npm run generate-routes` | Regenerate `src/routeTree.gen.ts` after adding routes; never edit that file. |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` bindings. |

`npm run dev` needs Docker, for the Computer container, and a `wrangler login`, because the `AI`, `BUCKET`, and Artifacts bindings are remote in local development. Local Durable Object state lands in `.wrangler/` and can hold transcripts and workspace files; do not publish it. Set the GitHub App secrets locally in `.dev.vars` or `.env`, and keep account-specific configuration in an ignored `wrangler.local.jsonc` (`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.local.jsonc` for Vite, `--config` for Wrangler). Press `t + Enter` in `npm run dev` for a Quick Tunnel when testing the GitHub webhook locally.

## Layout

```
src/
├── server.ts            Worker entry: /api/agents/* to the Agents SDK, then TanStack Start
├── contract.ts          the browser-safe contract: types, routes, RPC
├── router.tsx, routes/  TanStack Router; routeTree.gen.ts is generated
├── components/          React components, flat
├── hooks/, lib/         session/registry connections; transcript reducer, theme, mentions
└── server/              Worker only
    ├── pi-session.ts    one Durable Object per session: PiHarness, tools, task, web
    ├── pi-registry.ts   singleton catalog Durable Object, the only route to a session
    ├── agent-routes.ts  routing; refuses direct /api/agents/pi-session/* requests
    ├── skills.ts        skill sources and publishing; repo-skills.ts the clone's own skills
    ├── workspace-tools.ts, web-tools.ts, task.ts, github-app.ts, models.ts
    └── bundled-skills/  built-in skills, bundled by the Agents Vite plugin at build time
test/
├── unit/     browser unit tests (jsdom), mirroring src/ paths
└── worker/   Worker tests in workerd; entry.ts and its own wrangler.jsonc
container/Dockerfile      computerd image, pinned in step with @cloudflare/computer
```

Imports across directories use the `~/` alias for `src/`; imports within a directory stay relative.

## UI conventions

The UI is Kumo (`@cloudflare/kumo`), imported per component (`@cloudflare/kumo/components/button`), with Phosphor icons. Layout and colour are Tailwind utilities on Kumo's semantic tokens (`bg-kumo-base`, `text-kumo-subtle`, `border-kumo-hairline`) — never raw palette colours and never `dark:` variants; Kumo switches modes through `data-mode`. The UI is mobile-first: the below-`md` layout is the baseline, `md:`/`lg:` add the desktop arrangement. The session page splits Chat and Workspace only when its `main` is at least 56rem wide, by container query, not viewport. `src/styles.css` holds only what utilities cannot reach: Streamdown's rendered Markdown and keyframes.

## Testing

- Browser code is tested in `test/unit` at the same path as the code it tests (`src/lib/transcript.ts` → `test/unit/lib/transcript.test.ts`).
- Everything that runs in the Worker, pure modules included, is tested in `test/worker` under workerd, with `@cloudflare/vitest-pool-workers` and the config in `test/worker/wrangler.jsonc`. The suite drives a real `PiSession` with pi-ai's faux models — no live inference, container, or GitHub.
- New bundled skills change the built-in catalog: update the assertions in `test/worker/skills.test.ts` that list the built-in skill names.

## Skills

Two skills ship in `.agents/skills/`, vendored from [cloudflare/skills](https://github.com/cloudflare/skills) under the Apache License 2.0: `agents-sdk` and `durable-objects`. Activate `agents-sdk` before changing code that uses the `agents` package — `PiSession`, `PiRegistry`, the harness, routing — and `durable-objects` before changing Durable Object state, storage, alarms, or the bindings and migrations in `wrangler.jsonc`. Both bias towards retrieval from current Cloudflare docs over pre-trained knowledge.

Skills in this app come from three sources: built-ins in `src/server/bundled-skills/`, the clone's own skills under `.agents/skills/` (`src/server/repo-skills.ts`), and shared skills under `skills/` in the R2 bucket. A built-in skill wins a name; a repository's skill wins over a shared one.

## Platform gotchas

- `compatibility_date` in `wrangler.jsonc` is the newest date the bundled workerd supports. `package.json` overrides the `miniflare` and `wrangler` that `@cloudflare/vitest-pool-workers` pins so dev, tests, and deploys share one runtime; bump the date together with Wrangler, and drop the override once the pool ships a matching Miniflare.
- Never edit an old Durable Object migration; always add a new tag.
- Worker Previews (`npx wrangler preview`) inherit nothing from the main config: `previews` in `wrangler.jsonc` repeats bindings, and R2/Artifacts point at separate `-preview` resources.
- `wrangler deploy` refuses to run until all six GitHub App secrets are set (`npx wrangler secret put <NAME>`).

## Definition of done

`npm run check` is exactly what CI runs — lint, typecheck, both test projects — and `npm run build` builds the Worker and UI. Run them when the change touches code, configuration, or generated files; for Markdown-only changes, skip them: nothing in a test or build reads this repository's Markdown, and CI runs both anyway. Commit only when the user asks; the workspace git already commits as the GitHub App's bot.
