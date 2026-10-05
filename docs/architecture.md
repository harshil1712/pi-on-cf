# Pi on Cloudflare Architecture

This document describes the current Pi on Cloudflare system design and its known limitations. It reflects the migration to `@earendil-works/pi-durable` 1.0, `agents` 0.26, and `@cloudflare/computer` 0.4.

## System Overview

Pi on Cloudflare is a TanStack Start application deployed as a Cloudflare Worker. It combines:

- Pi's durable harness, `@earendil-works/pi-durable`, hosted by the Agents SDK's `PiHarness` (`agents/harness/pi`).
- Workers AI and AI Gateway through `agents/models/pi-ai` and the `AI` binding.
- One `PiSession` Durable Object per session, owning the Pi conversation and a Cloudflare Computer workspace.
- A singleton `PiRegistry` Durable Object for the session catalog.

The Worker routes `/api/agents/*` through the Agents SDK and sends other requests to TanStack Start. The browser has a session catalog at `/` and a workspace at `/sessions/:sessionId`.

Relevant source:

- `src/server.ts`
- `src/shared/pi-contract.ts`
- `src/server/pi-session.ts`
- `src/server/pi-registry.ts`
- `wrangler.jsonc`

## PiSession

Each session ID addresses one `PiSession`, an Agents SDK `Agent` composed with two Computer mixins:

- `withWorkspaceContainer` makes the object the host of its own Computer container.
- `withWorkspace` builds the `Workspace` and serves it to Computer's Worker Shell through `__getWorkspaceStub`.

### Pi

`PiHarness` opens pi-durable over the object's SQLite, in tables prefixed `pi_`, and registers with the Agent's Lifecycle. Pi owns everything about a run: the transcript, the inbox of steers and follow-ups, generation and tool tasks, retries, automatic compaction, and crash recovery. While Pi has work, the harness keeps one Lifecycle job per session; if the object is evicted mid-run, that job's alarm restarts it and Pi resumes from its last commit. The application does not override `alarm()`.

The session uses Pi's root conversation. The harness factory installs one Pi extension containing:

- a `preamble` system-prompt section describing the workspace;
- Computer's tools from `createPiTools`, adapted to pi-durable tool registrations in `src/server/workspace-tools.ts`.

Tool calls in a round run sequentially. Reads, searches, `write`, and `delete` are marked replay-safe; `edit` and `exec` are reported to the model as interrupted if an eviction cuts them off.

The model comes from `createAI({ binding: env.AI })`. New sessions start on `AI_MODEL` at the `medium` thinking level.

### Transport

Commands are `@callable` methods: `submit`, `steer`, `abort`, `listFiles`, and `readWorkspaceFile`. `submit` resolves once Pi has durably accepted the prompt, before the model runs.

Each WebSocket connection gets its own `session.events()` watch. The first frame is a `snapshot`; each later frame is one batch of Pi agent events per commit. The client folds them with the reducer in `src/features/workspace/transcript.ts`. Watches live in memory, so `onStart` re-watches every connection that outlived the previous isolate and sends a fresh snapshot. A reconnecting browser always starts from the current state, including an in-flight answer.

### Workspace

The Computer workspace is rooted at `/workspace` and has three `exec` backends:

| Backend | Runtime |
| --- | --- |
| `shell` | Worker Shell: just-bash with text utilities and git, in a Dynamic Worker |
| `javascript` | Worker JavaScript: ES modules with `node:fs/promises`, `ws:git`, and `ws:artifacts` |
| `container` | `ContainerBackend`: a Durable Object-scheduled Cloudflare Container running `computerd`, with direct egress |

The container dials back to the object at `/api` through `WorkspaceProxy`; `PiSession.fetch` hands that upgrade to the backend. The workspace also has git and session Artifacts.

## PiRegistry

The singleton `PiRegistry` stores each session's ID, optional name, and timestamps. It creates, lists, renames, and deletes sessions. Deleting a session aborts its run, stops its container, and schedules `destroy()` on its `PiSession` through the Agents SDK's destroy alarm, which drops Pi's tables and the workspace in a separate invocation. Scheduling it, rather than calling `destroy()` inline, keeps the isolate abort from racing the reply to the registry; the catalog row is removed only after that teardown succeeds, so a failed delete can be retried. A `PiSession` touches its registry row when it accepts a prompt.

## Security Model

The application has no authentication or authorization. Anyone who can reach a deployment can list, read, change, and delete every session and workspace, and run models on the account's AI binding. Session UUIDs are isolation mechanisms, not authorization boundaries. Protect the whole Worker with Cloudflare Access or another authentication layer.

Local `.wrangler/` state can contain transcripts and workspace files.

## Known Limitations

From the current SDKs:

- `pi-durable` and `PiHarness` are experimental and beta; their APIs change between releases.
- Pi's conversations are linear. There is no in-session tree, leaf navigation, labels, or branch summaries; branching in pi-durable means forking a conversation, which this application does not expose yet.
- Pi's retry and polling timers live in memory. `PiHarness` covers generation backoff, but a custom task's sleep is not durable.
- A single model stream longer than an alarm's 15-minute wall time is at the platform's mercy.
- Abort waits for tools to honor their abort signal. In Computer 0.4, killing a Worker Shell `exec` blocks until the command exits, so aborting a long shell command takes as long as the command; container commands stop at once. `abort` therefore returns before Pi settles, and the event stream reports when the session is idle.
- An Agent method that throws over native RPC is also logged as an uncaught rejection by the Agents SDK's tracing wrapper.

Not implemented in this application:

- Authentication and per-user isolation.
- Forks, clones, and session search.
- Long-term memory.
- Manual compaction, context reset, model and thinking-level selection.
- Image input, usage and cost display.
- Sharing files by link. Computer's `publish` tool needs Assets, which are backed by R2; the application configures neither.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The Workers suite runs a real `PiSession` with pi-ai's faux provider: a plain answer, a model tool call that writes through Computer, and the WebSocket snapshot. It also exercises Computer's Worker Shell, git, Worker JavaScript, and the tool adapter. Live Workers AI inference and the container backend are not covered by tests.
