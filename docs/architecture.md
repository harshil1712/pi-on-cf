# Pi on Cloudflare Architecture

This document describes the current Pi on Cloudflare system design, its implemented capabilities, and its known limitations. It reflects the source tree as of July 29, 2026.

## System Overview

Pi on Cloudflare is a TanStack Start application deployed as a Cloudflare Worker. It combines:

- Pi's `AgentHarness` and `Session` abstractions from `@earendil-works/pi-agent-core`.
- One `PiSession` Durable Object per session.
- A singleton `PiRegistry` Durable Object for discovery, search, lineage, and learned memory.
- A SQLite-backed virtual filesystem from `@cloudflare/shell`.
- Cloudflare AI Gateway through Pi's OpenAI-compatible provider adapter.
- Agents SDK RPC and streaming between the React client and Durable Objects.

The Worker routes `/api/agents/*` requests through the Agents SDK and sends other requests to TanStack Start. The browser provides a session catalog at `/` and a workspace at `/sessions/:sessionId`.

Relevant source:

- `src/server.ts`
- `src/shared/pi-contract.ts`
- `src/routes/index.tsx`
- `src/routes/sessions.$sessionId.tsx`
- `wrangler.jsonc`

## Durable Object Responsibilities

### PiRegistry

The singleton `PiRegistry` owns global application data:

- Session metadata and lifecycle status.
- Session names, timestamps, message counts, active leaves, and lineage.
- Full-text and regular-expression transcript search indexes.
- Idempotent processing of session index events.
- Deletion tombstones that prevent delayed events from recreating deleted sessions.
- Global learned memories and memory-extraction records.

It creates UUID-named sessions and coordinates rename, deletion, fork, and clone operations. Search covers non-empty user and assistant text; it does not index reasoning, tool output, compaction summaries, or workspace files.

Relevant source:

- `src/server/pi-registry.ts`
- `src/server/pi-session-storage.ts`

### PiSession

Each session ID addresses a separate `PiSession`. It owns:

- Pi session metadata and append-only tree entries.
- The active tree leaf.
- The cached `AgentHarness` and active-turn coordination.
- Per-session compaction settings.
- The transcript-index outbox and memory-extraction cursor.
- An isolated durable workspace.

The transcript and workspace use the Durable Object's SQLite storage. Completed entries and file changes survive object eviction, but in-memory execution state does not.

Relevant source:

- `src/server/pi-session.ts`
- `src/server/pi-session-storage.ts`

## Session Trees and Persistence

`PiSessionStorage` implements Pi's `SessionStorage` contract over Durable Object SQLite. Entries retain their Pi ID, parent ID, type, timestamp, and serialized payload. These links form an append-only tree.

The active branch is the path from the selected leaf to the root. Moving through history appends a leaf entry rather than deleting later history. The UI exposes the tree and supports revising a previous user message.

The application supports:

- Creating, naming, listing, searching, and deleting sessions.
- Navigating branches without deleting history.
- Forking from a selected user message.
- Cloning the active branch.
- Entry labels and parent-session lineage in the server contract.
- Automatic and manual context compaction.
- Abort, steering, and follow-up operations in the server contract.

A fork copies the branch before the selected user message. A clone copies the active branch. Both copy the source session's current workspace and compaction settings. Workspace files are current-state copies, not historical snapshots from the selected transcript entry.

Registry indexing uses a durable outbox. Appending a searchable message and its outbox event is atomic; delivery to `PiRegistry` is asynchronous and idempotent.

## Agent and Model Flow

`PiSession` lazily constructs one `AgentHarness` per live Durable Object instance. The harness receives:

- A `Session` backed by `PiSessionStorage`.
- Workspace, session-search, and memory tools.
- A system prompt that includes global learned memory.
- A fixed `medium` thinking level.
- Cloudflare AI Gateway metadata containing the session ID.

Provider configuration comes from:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `AI_GATEWAY_ID`
- `AI_MODEL`
- `AI_MEMORY_MODEL`

The committed Gateway ID is the neutral `default`. Account-specific configuration must not be committed to `wrangler.jsonc`.

During a prompt, the session validates configuration and prompt size, prevents a second active prompt, compacts context when needed, runs the model/tool loop, streams translated Pi events to the browser, and schedules indexing and memory extraction. The browser reloads the authoritative branch and workspace after completion.

Completed Pi messages are durable. Partial token deltas, the browser's stream position, abort state, and steering/follow-up queues are not durable across a Durable Object restart.

Relevant source:

- `src/server/create-pi-harness.ts`
- `src/server/pi-session.ts`
- `src/server/stream-events.ts`
- `src/features/workspace/use-pi-session.ts`

`src/server/create-pi-agent.ts` is a legacy low-level factory and is not used by the production request path.

## Workspace and Tools

Each session has an isolated `@cloudflare/shell` workspace. The model can use:

- `read`
- `write`
- `edit`
- `list`
- `find`
- `grep`
- `session_search`
- `memory`

The browser can list, preview, and download text files. The model can modify the entire session workspace without an approval step.

The application does not provide a POSIX shell, native process execution, Git, package installation, preview servers, or a general network-fetch tool. Workspace operations are text-oriented.

Relevant source:

- `src/server/workspace-tools.ts`
- `src/server/memory-tools.ts`
- `src/features/workspace/components/workspace-browser.tsx`

## Compaction

Before a prompt, Pi estimates active-branch context usage and compares it with the model context window and persisted compaction settings. When required, it appends a native Pi compaction entry containing the summary, retained entry boundary, usage, and retained tail. Original tree entries remain stored.

Manual compaction is available in the UI. The server contract also supports changing reserve and recent-token settings, though the current UI does not expose all settings.

Relevant source:

- `src/server/pi-session.ts`
- `src/server/manual-compaction.ts`

## Learned Memory

Learned memory is global to the singleton registry and therefore shared by every session. Memories are classified as preferences, facts, instructions, or decisions and may retain source-session and source-entry provenance.

Memory can change in two ways:

- The model-facing memory tool can add, update, or delete memory when instructed by the user.
- Background extraction processes bounded batches of completed user and assistant messages after turns.

Memory is injected into later system prompts and survives deletion of its source session. The application limits memory size and rejects selected recognizable secret formats, but this is not a complete data-loss-prevention boundary. There is currently no memory-management UI.

Relevant source:

- `src/server/memory-extractor.ts`
- `src/server/memory-tools.ts`
- `src/server/pi-registry.ts`
- `src/server/pi-session.ts`

## Security Model

The application has no authentication or authorization. Agent routing happens before any identity check, and the registry is a shared singleton.

Anyone who can reach a deployment can potentially:

- List and search all sessions.
- Read transcripts and workspace files.
- Create, rename, fork, clone, or delete sessions.
- Submit model requests using the server-side Cloudflare token.
- Influence global learned memory.

Session UUIDs and Durable Object names are isolation mechanisms, not authorization boundaries. This repository is therefore suitable only for local use or a deployment whose entire Worker is protected by Cloudflare Access or another authentication layer.

Local `.wrangler/` state can contain transcripts, memory, and workspace files. It is ignored by Git and must not be included in manually created source archives.

## Current Product Gaps

Not currently implemented:

- User or tenant isolation.
- Application-level authentication and authorization.
- Resumable streams or recoverable active turns.
- Durable steering and follow-up queues.
- Historical workspace snapshots for forks.
- Semantic or vector search.
- User-facing import, export, or sharing.
- Image uploads or multimodal prompts.
- Model and thinking-level selection.
- Usage and cost reporting.
- Native shell, Git, package installation, or test execution.
- Memory-management controls.

## Verification

The repository provides separate browser/unit and Workers test suites:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Tests cover session isolation, transcript indexing, forks, deletion tombstones, memory extraction, manual compaction preparation, catalog behavior, workspace orchestration, transcript conversion, and transcript rendering. Live AI Gateway inference, real provider abort behavior, stream recovery, and authentication are not covered.
