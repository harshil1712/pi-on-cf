# Pi on Cloudflare architecture

This describes the application as built with `@earendil-works/pi-durable` 1.5, `agents` 0.33, and `@cloudflare/computer` 0.10. PiHarness and parts of Computer are beta, so their APIs may change between releases.

## Overview

A TanStack Start application runs in one Cloudflare Worker. It serves the UI, GitHub and generic webhooks, and `/api/agents/*` traffic. The UI uses Kumo components, Phosphor icons, and Tailwind utilities.

Two kinds of Durable Objects back it:

- **`PiSession`**: one per coding session, owning a Pi conversation, workspace, container, browser, and task state.
- **`PiRegistry`**: a singleton session catalog and the owner of shared MCP servers. Clients reach sessions only through this registry; direct `/api/agents/pi-session/*` routes are rejected.

`src/server.ts` is the Worker entry. `src/contract.ts` defines the browser-safe RPC and message types.

## PiSession

### Durable execution

`PiSession` extends an Agents SDK `Agent` through Computer's workspace mixins. `PiHarness` opens pi-durable over the object's SQLite in tables prefixed `pi_` and integrates it with the Agents Lifecycle.

Pi owns transcript entries, steer/follow-up queues, generation, tools, retries, compaction, and recovery. While work is pending, the harness keeps a wake job on the Durable Object alarm. After eviction, Pi reopens from committed state and resumes its scheduler. `onWake` lets Pi sleep without keeping a timer or the object awake.

Tasks repeatedly cut off by crashes reach `restartLimit` and fail visibly instead of restarting forever. Reports use the single `onReport(report)` shape with a `kind` and `error`.

The extension registry installs:

- the environment and repository prompt sections;
- Computer file and execution tools;
- GitHub task tools;
- skill tools;
- `web_fetch`, optional `web_search`, and the browser tool;
- the codemode `mcp` tool when enabled servers exist.

Tool calls in a round run sequentially. Reads are replay-safe; operations that may repeat external effects are not replayed automatically after interruption.

### Models

`createAI` connects Workers AI through the configured AI Gateway. New sessions default to **DeepSeek V4.1 Flash** with **high** reasoning. The picker also offers **GLM 5.3**; its curated entries are in `src/server/models.ts`. Model changes take effect on the next generation; the UI disables the picker while Pi is running.

### Conversation transport and status

Each WebSocket connection gets a `session.watch()` conversation-view watch. Every `pi:view` frame carries a complete `TranscriptView`: entries, live generation, tools, run state, and inbox. `ConversationTranscript` pages older entries on connection and fills window gaps, so reconnects and long transcripts remain complete. The browser projects these views in `src/lib/transcript.ts` and batches them once per animation frame.

A second watch derives the catalog's `idle`, `running`, or `failed` status from `pi.live.run` and `pi.live.runFailure`. Status changes update the registry entry and its revision, which synchronizes open sidebars.

When the registry deletes a session, deferred teardown stops watches and the container, deletes session Artifacts, closes Pi, and wipes the object's storage.

## Workspace

The workspace is rooted at `/workspace` and has three execution backends:

| Backend | Purpose |
|---|---|
| `shell` | just-bash, text utilities, jq, and workspace git in a Dynamic Worker |
| `javascript` | Codemode ES modules with `node:fs/promises`, `codemode:git`, and `codemode:artifacts` |
| `container` | A Durable Object-scheduled Linux container running `computerd`, for package managers, builds, tests, and native binaries |

The container has direct egress and calls back through `WorkspaceProxy`. `container/Dockerfile` pins the same `computerd` version as `@cloudflare/computer`. Dependency directories stay on container-local storage to avoid syncing thousands of files into the Durable Object.

Workspace git uses `createGitClient()`. Commits use the GitHub App bot identity from `GITHUB_APP_SLUG` and `GITHUB_APP_BOT_ID`. Artifacts are scoped to the session's Durable Object ID.

### Repository tasks

A session clones at most one repository when the model calls `clone_repository`. The task records the repository, base branch and commit, task branch, and workspace directory. The model receives the repository's `AGENTS.md` in its prompt.

`create_pull_request` refuses uncommitted changes, pushes only the task branch, then opens or updates a draft pull request. Pull request and repository metadata are mirrored into the registry entry for the catalog.

The GitHub App mints installation tokens for individual repositories. Tokens are passed to clone and push calls only; workspace git and the container do not retain credentials. Installations outside `GITHUB_OWNERS` are ignored.

## Web, MCP, and skills

### Web

- `web_fetch` uses Workers AI to convert pages to Markdown and returns bounded windows.
- `web_search` uses the configured provider key on AI Gateway. The checked-in provider is Exa, enabled only when `WEB_SEARCH_PROVIDER` is set.
- `Browser` uses a persistent Browser Run browser. Live View URLs are refreshed for the UI and are intentionally short-lived.
- `preview.internal` lets the session browser reach a dev server in its container through `InternalHostRouter`. Only that session can reach it, cross-origin requests are rejected, WebSockets are unsupported, and it is unavailable in local development.

Web results are untrusted content, not instructions.

### MCP

The registry owns MCP connections and credentials through `MCPClientManager`. Sessions see only enabled tools. The codemode `mcp` extension discovers and invokes tools through registry RPC, so session storage never receives server credentials. Catalog changes synchronize when Pi opens and after accepted prompts.

### Skills

Skill sources have this precedence:

1. Built-ins from `src/server/bundled-skills`, loaded as raw files into an Agents `manifest()` source.
2. Repository skills from `.agents/skills`, `.claude/skills`, `.pi/skills`, and `.github/skills`, read into a fresh manifest for each catalog listing.
3. Shared skills under `skills/` in R2, read with the Agents `r2()` source and cached for up to a minute.

`SkillCatalog` reinstalls the Pi extension when the catalog's prompt fingerprint changes. Only names and descriptions enter the default prompt; `activate_skill` loads instructions and `read_skill_resource` loads files. `open_skill`, `save_skill`, and `delete_skill` manage shared skills from the workspace.

## Webhooks

- `/webhooks/github` verifies `GITHUB_WEBHOOK_SECRET`, accepts only issue and review comments from users in `GITHUB_OWNERS`, and queues mentions on the registry. Issue mentions continue an existing session or create one; mentions on unrelated pull requests receive 😕.
- `/webhooks/generic` verifies `WEBHOOK_SECRET`, limits bodies to 64 KiB, treats payloads as untrusted data, and starts one queued session per accepted delivery.

Both endpoints return before model work runs. The registry's durable queue handles retries. These paths need explicit Cloudflare Access bypasses; everything else should remain protected.

## Security model

The application has no built-in authentication or authorization. Use Cloudflare Access or another authentication layer for the whole Worker, with only the two webhook paths exempt.

Repositories, issues, comments, web pages, MCP results, and skills can all carry prompt injection. Pi can run code in a networked container and act through enabled MCP credentials, so configuration and repository write access must be treated as security boundaries. Shared skills affect every session and can be published by an agent without review.

Session IDs isolate resources but are not authorization tokens. Preview URLs are public and should also be protected. Local `.wrangler/` state can contain sensitive transcripts and workspace files.

## Current limitations

- No per-user authentication, session search, scheduled work UI, subagent UI, or multiple-conversation UI.
- No automatic review/CI follow-up after a pull request opens.
- Container-backed execution and Artifacts are not covered by the workerd suite; those require live checks.
- Browser internal hosts require a deployed Worker and do not support hot-reload WebSockets.
- Abort completes only after tools honor cancellation.

## Verification

```bash
npm run check
npm run build
```

The worker tests run a real `PiSession` with faux models and cover sessions, catalog state, views, tools, skills, MCP, webhooks, and failure recovery without live inference, GitHub, or containers. Browser checks cover deployment and live-model integration.
