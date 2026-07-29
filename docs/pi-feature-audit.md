# Pi Feature and Cloudflare Platform Audit

This document records how the current Pi coding agent works, which capabilities
Pi on Cloudflare currently implements, and which Cloudflare products could
provide the missing infrastructure. It is a research artifact, not an
implementation plan.

## Research Scope

The audit was performed on July 28, 2026 against:

- The published `@earendil-works/pi-coding-agent` release `0.82.1`.
- The published `@earendil-works/pi-agent-core` release `0.82.1`, which this
  project uses.
- The upstream Pi `main` branch at commit
  [`063fb963`](https://github.com/earendil-works/pi/commit/063fb963c5c33d099faa593d17e60e0a875430cd).
- Cloudflare Agents SDK, Think, Session API, Shell, Workspace, Sandbox,
  Containers, Dynamic Workers, Workflows, AI Gateway, and related documentation.
- The current Pi on Cloudflare source tree.

Cloudflare's Agents and execution APIs are evolving quickly. Product maturity
and exact APIs should be checked again before implementation.

## Executive Summary

Pi on Cloudflare embeds Pi's low-level `Agent` loop. It does not embed the full
Pi coding-agent application or use Pi's higher-level `AgentHarness` and session
abstractions.

The current application provides:

- A streamed Pi model and tool loop.
- A durable virtual workspace backed by Durable Object SQLite.
- `read`, `write`, `edit`, `list`, `find`, and `grep` tools.
- Persistent flat transcript history.
- Reasoning, text, and tool-status rendering.
- A browser file explorer and text-file downloads.
- Cloudflare AI Gateway model routing.

The most important missing Pi behaviors are:

- Multiple named sessions, resume, deletion, and search.
- Incremental append-only session persistence.
- Session trees, navigation, forks, clones, labels, and lineage.
- Automatic and manual context compaction.
- Abort, steering messages, follow-up messages, and transient-error retries.
- Context files, skills, prompt templates, and resource reload.
- Model and thinking-level selection.
- Token, cost, and context-window accounting.
- Image input and richer tool output.
- Export, import, and sharing.

Pi does not have built-in automatic long-term memory, semantic cross-session
recall, a `MEMORY.md` convention, or a model-facing session-search tool.

## Pi Core Versus Pi Coding Agent

The distinction between the packages is central to this audit.

| Layer | Responsibility |
| --- | --- |
| `@earendil-works/pi-ai` | Model/provider abstraction, authentication, streaming, usage, and transport |
| `@earendil-works/pi-agent-core` | Agent loop, messages, tools, events, generic harness, and storage interfaces |
| `@earendil-works/pi-coding-agent` | CLI/TUI, session browser, JSONL persistence, compaction orchestration, resources, settings, extensions, and user workflows |

Pi on Cloudflare imports the low-level `Agent` from
`@earendil-works/pi-agent-core` in `src/server/create-pi-agent.ts`. It creates a
new agent for each prompt, restores a stored `AgentMessage[]`, runs the prompt,
and writes the complete array back in `src/server/pi-session.ts`.

That means features implemented by Pi's coding-agent runtime do not become
available merely because `pi-agent-core` is installed.

## Current Application Architecture

### Session identity

The browser always connects to the named Durable Object `workspace`:

- `PI_SESSION_NAME` is fixed in `src/shared/pi-contract.ts`.
- `usePiSession()` passes that name to `useAgent()` in
  `src/features/workspace/use-pi-session.ts`.

There is no session registry, user-derived identity, URL session identifier, or
authentication boundary. Every permitted caller targets the same logical
workspace.

### Transcript persistence

`PiSession` stores the complete `AgentMessage[]` under the Durable Object key
`messages`:

- `loadTranscript()` reads the array.
- `prompt()` reloads it before constructing a Pi agent.
- The updated array is stored in `finally` after the agent settles.
- `clearTranscript()` deletes the key permanently.

The workspace files are stored separately in the same Durable Object SQLite
database through `@cloudflare/shell`. Clearing the transcript does not clear
the files.

Consequences of the current snapshot model include:

- The active turn is not durable until the complete prompt finishes.
- A runtime failure can lose the current turn.
- There are no stable transcript entry IDs or append cursors.
- There is no branch, compaction, label, model-change, or lineage metadata.
- A refreshed client cannot resume the active stream.

### Agent lifecycle

The server uses an in-memory `active` boolean to reject concurrent prompts.
The active Pi agent is a local variable inside `prompt()`, so other RPC methods
cannot abort it, steer it, or enqueue follow-up work.

### Workspace

The application correctly uses `@cloudflare/shell` `Workspace` as a durable
virtual filesystem. The current custom tools expose only part of the package's
filesystem functionality and operate on UTF-8 text.

## How Pi Implements Sessions

### Storage and discovery

Pi stores sessions under `~/.pi/agent/sessions/`, grouped by working directory.
Each session is an append-only JSONL version 3 file.

The header records the session ID, creation time, working directory, and
optional parent session. Following lines are typed entries such as:

- Messages.
- Model and thinking-level changes.
- Compactions and branch summaries.
- Custom extension data and custom messages.
- Labels and session names.

Every entry has an `id` and `parentId`. These links form a tree, and an explicit
active leaf determines which branch supplies model context.

Sources:

- [Pi sessions](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/sessions.md)
- [Pi session format](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/session-format.md)
- [Pi SessionManager](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/session-manager.ts)

### Session operations

Pi supports:

- `/new` to start a session.
- `/resume` to browse and open previous sessions.
- `/name` to assign a human-readable name.
- `/tree` to move within the current session tree without deleting history.
- `/fork` to create a new session from an earlier user message.
- `/clone` to copy the active branch into a new session.
- Session deletion with confirmation.
- HTML and JSONL export, JSONL import, and private-gist sharing.

Forked and cloned sessions preserve parent-session provenance.

### Search

Pi's session picker builds searchable text from:

```text
session ID + session name + all user/assistant message text + working directory
```

It supports:

- Fuzzy token matching.
- Exact quoted phrases.
- `re:` regular expressions.
- Recent, relevance, and threaded sorting.
- Named-session filtering.

This is lexical search performed by the session picker. It is not semantic
search, and it is not available to the model as a tool.

Source:
[session-selector-search.ts](https://github.com/earendil-works/pi/blob/063fb963c5c33d099faa593d17e60e0a875430cd/packages/coding-agent/src/modes/interactive/components/session-selector-search.ts)

### Workspace relationship

Pi groups multiple sessions by working directory. Those sessions operate on
the same project files.

The proposed Pi on Cloudflare product requirement is different: each session
should own its own files. This is an intentional product divergence from Pi,
not a parity feature.

## How Pi Implements Context and Memory

Pi has no built-in learned-memory system and does not recognize `MEMORY.md`.

Pi loads explicit context files at startup:

- `~/.pi/agent/AGENTS.md` or `CLAUDE.md` for global context.
- `AGENTS.md` or `CLAUDE.md` from filesystem ancestors.
- `AGENTS.md` or `CLAUDE.md` from the current working directory.
- `.pi/SYSTEM.md` or global `SYSTEM.md` to replace the system prompt.
- `.pi/APPEND_SYSTEM.md` or global `APPEND_SYSTEM.md` to append to it.

The files are concatenated into the system prompt and reloaded on startup or
with `/reload`. Pi does not automatically modify them based on conversations.

Source:
[resource-loader.ts](https://github.com/earendil-works/pi/blob/063fb963c5c33d099faa593d17e60e0a875430cd/packages/coding-agent/src/core/resource-loader.ts)

Pi's other context mechanisms are distinct from long-term memory:

- The current session's active branch supplies conversation history.
- Compaction summaries replace older messages only in model context.
- Branch summaries preserve useful context when leaving a branch.
- Skills expose metadata globally and load complete instructions on demand.
- Prompt templates expand reusable user prompts.

Compaction and branch summaries remain attached to their originating session.
They do not search or learn from unrelated sessions.

### Pi on Cloudflare learned memory

Pi on Cloudflare adds application-level learned memory while preserving Pi's
runtime and session format. The singleton `PiRegistry` stores a bounded set of
concise facts, preferences, instructions, and decisions. Every Pi session reads
the same block when constructing its system prompt.

The model can update memory explicitly through the `memory` tool. After a turn
finishes, a background extraction pass examines only newly persisted user and
assistant text and submits structured changes tied to user-message provenance.
The source transcript is not copied into memory storage. Extraction progress is
recorded per session and registry writes are idempotent and version-checked.

This is a Pi on Cloudflare product feature, not behavior supplied by Pi core or
the Cloudflare Session API.

## How Pi Implements Compaction

Automatic compaction is enabled by default. Pi triggers it when estimated
context usage approaches the model window:

```text
context tokens > context window - reserve tokens
```

The default configuration reserves 16,384 tokens for the response and keeps
approximately 20,000 recent tokens.

Compaction:

1. Chooses a cut point while keeping tool calls and results together.
2. Keeps recent complete turns.
3. Summarizes older content with a structured prompt.
4. Incorporates the previous summary during repeated compactions.
5. Records files read and modified.
6. Appends a compaction entry instead of deleting history.
7. Rebuilds model context from the summary and retained messages.

The original session entries remain available for tree navigation and export.
Pi also supports manual `/compact` with optional focus instructions.

Source:
[Pi compaction](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/compaction.md)

## How Pi Implements Active Turns

### Abort

Pi keeps the active agent runtime available and can abort the current provider
stream and tools. Queued messages are restored to the editor after an abort.

### Steering and follow-up

Pi has two user-visible queues:

| Queue | Delivery behavior |
| --- | --- |
| Steering | Delivered after the current assistant turn and its tool calls, before the next model call |
| Follow-up | Delivered after the agent would otherwise finish all work |

Both support one-at-a-time or all-at-once delivery. The low-level Pi `Agent`
already exposes steering and follow-up methods, but Pi on Cloudflare cannot use
them across RPC calls because its agent exists only as a local variable during
`prompt()`.

### Retry

Pi retries transient provider, network, rate-limit, and server failures with
bounded exponential backoff. Quota, billing, and budget failures fail fast.
Context overflow is handled through compaction and retry rather than ordinary
transient-error retry.

## Pi Resources and Customization

### Skills

Pi implements the Agent Skills standard:

1. It scans configured global, project, package, and explicit paths.
2. It places skill names and descriptions in the system prompt.
3. The model uses `read` to load a matching `SKILL.md` on demand.
4. `/skill:name` can force explicit activation.

This progressive-disclosure model avoids loading every skill body into every
prompt.

Source:
[Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

### Prompt templates

Markdown prompt templates support arguments and expand into user prompts.
They are available as slash commands.

### Extensions and packages

Pi extensions are trusted TypeScript modules that can register tools,
commands, keyboard shortcuts, lifecycle hooks, providers, and UI components.
Packages distribute extensions, skills, prompts, and themes through npm, Git,
URLs, or local paths.

Extensions and packages execute with the local user's privileges. Pi uses
project trust to control whether project-local executable resources load, but
project trust is not a sandbox.

Pi intentionally does not include built-in MCP, sub-agents, permission popups,
plan mode, to-do management, or background Bash. Those can be implemented by
extensions or external tools.

## Pi Tools and Interaction

Pi's default model tools are `read`, `write`, `edit`, and `bash`. Optional
built-ins include `grep`, `find`, and `ls`.

Compared with the current custom tools, Pi's higher-level tool implementations
also provide:

- Text offsets, line limits, and output truncation.
- Binary and image detection.
- Multiple edit operations with diff and patch details.
- Abort handling and streamed progress.
- Same-file mutation serialization.
- Full-output fallback for truncated shell output.

Other Pi interaction features include:

- Image paste, drag-and-drop, and `@file` references.
- Project-file fuzzy search and path completion.
- Model and reasoning-level selection.
- Token, cache, cost, and context-window statistics.
- Collapsible reasoning and tool output.
- Copying the last assistant response.
- Interactive, print, JSON event, RPC, and SDK modes.

## Feature Comparison

| Capability | Pi implementation | Pi on Cloudflare | Cloudflare platform fit |
| --- | --- | --- | --- |
| Durable identity | Local session ID and file | One fixed named DO | Agents and Durable Objects |
| Persistent transcript | Append-only JSONL tree | Flat `AgentMessage[]` snapshot | DO SQLite or Session API |
| Multiple sessions | Session files grouped by cwd | Missing | SessionManager or a user registry |
| Session search | Fuzzy, phrase, regex | Missing | Session API FTS5 or application index |
| Branching | Explicit tree and active leaf | Missing | Pi storage adapter; Session API is only partially equivalent |
| Fork and clone | Copy active path with lineage | Missing | Pi storage adapter or SessionManager fork |
| Compaction | Non-destructive session entries | Missing | Pi AgentHarness or Session overlays |
| Abort | Active runtime cancellation | Missing | Pi Agent abort and Agents cancellation |
| Steering/follow-up | In-memory turn queues | Missing | Pi core plus persistent Agent instance |
| Retry | Classified exponential retry | Missing | Pi runtime, Think, or Workflows |
| Stream resumption | RPC lifecycle managed by client | Missing on browser refresh | AIChatAgent or Think recovery |
| Context files | `AGENTS.md`, `CLAUDE.md`, system files | Missing | Workspace plus prompt assembly |
| Writable memory | Not built in | Global curated context with explicit and automatic updates | Registry SQLite; Session context-block pattern |
| Skills | Progressive disclosure | Missing | Pi harness or Agents Skills |
| Prompt templates | Markdown command expansion | Missing | Pi harness or application implementation |
| Extensions | Trusted TypeScript modules | Missing | Dynamic Workers or Think extensions, not Pi-compatible |
| Durable files | Local filesystem | Implemented | `@cloudflare/shell` Workspace |
| Structured file operations | Native tools and shell utilities | Partial | `@cloudflare/shell` state APIs |
| Git | Native Git | Missing | `@cloudflare/shell/git` or Sandbox |
| Real shell/processes | Local OS shell | Missing | Sandbox or Containers |
| Shell emulation | Not used | Missing | `just-bash` |
| Model routing | Pi provider collection | Fixed AI Gateway model | AI Gateway, Workers AI, Pi providers |
| Model/thinking controls | Persisted session changes | Fixed values | Pi core with session state |
| Images | Multimodal prompts and file references | Missing | Pi core plus image-capable model |
| Usage/cost | Session statistics | Missing | Pi usage plus AI Gateway analytics |
| Export/import/share | HTML, JSONL, gist | Missing | Application implementation and R2 |
| Authentication | Local OS user boundary | Missing | Cloudflare Access or application auth |

## Cloudflare Platform Findings

### Agents and Durable Objects

The Agents SDK supplies durable identity, SQLite storage, WebSockets, RPC,
scheduling, task queues, sub-agents, and recoverable execution primitives.
Durable Objects are a natural boundary for a user, workspace, or active agent.

The current application already uses Agents routing and a SQLite Durable
Object, but does not use most lifecycle and recovery features.

### Cloudflare Session API

The experimental Session API provides:

- Tree-structured AI SDK messages.
- Multiple named sessions within one Durable Object.
- Per-session and cross-session SQLite FTS5 search.
- Session creation, listing, renaming, deletion, and forking.
- Persistent context blocks.
- Writable, searchable, and skill context providers.
- Generated `set_context`, `load_context`, `search_context`, and
  `session_search` tools.
- Non-destructive compaction overlays.
- Token and cost counters.
- Optional Postgres providers through Hyperdrive.

Source:
[Cloudflare Sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)

The API is inspired by Pi but is not storage-compatible with Pi:

| Pi session semantics | Cloudflare Session semantics |
| --- | --- |
| Heterogeneous append-only entry tree | AI SDK-style message tree |
| Explicit persisted active leaf | Latest childless message is treated as the leaf |
| Model, tool, label, compaction, and custom entries are tree nodes | Messages are tree nodes; compactions are overlays |
| Leaf movement can occur without appending a message | No equivalent persistent leaf-movement operation |
| Pi-specific branch and compaction reconstruction | Cloudflare-specific branch and overlay reconstruction |

Using Cloudflare Session as a transparent backend for Pi would require a
lossy translation. A Pi-compatible Durable Object `SessionStorage` would
preserve Pi semantics more accurately.

The Session API remains experimental under
`agents/experimental/memory/session`.

### Think

`@cloudflare/think` is an opinionated Cloudflare agent harness inspired by Pi.
It provides:

- An AI SDK agent loop.
- Message persistence and Session integration.
- Stream resumption and durable recovery.
- Workspace tools.
- Context blocks and writable memory.
- Compaction and context-overflow recovery.
- Client tools and approval flows.
- Skills, MCP, browser tools, extensions, scheduled tasks, and sub-agents.
- Durable programmatic turn submission with idempotency.

Source:
[Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)

Think is a replacement harness, not an adapter around Pi's agent loop. Adopting
it would provide similar product features but would no longer exercise Pi's
runtime semantics.

### `@cloudflare/shell`

The installed `@cloudflare/shell` package provides a durable virtual
filesystem and structured state operations. It includes:

- SQLite-backed `Workspace`, optionally with R2 large-file storage.
- Text and byte file operations.
- Copy, move, delete, links, directories, globbing, and metadata.
- Search, replacement, JSON queries, archives, compression, hashing, and file
  detection.
- Transactional multi-file edit plans.
- Pure-JavaScript Git through `isomorphic-git`.
- A `state.*` provider for sandboxed JavaScript executed through
  `@cloudflare/codemode` and Dynamic Workers.

Despite its name, it is explicitly not a Bash interpreter. It does not parse
shell syntax, expose pipes, run native binaries, install packages, invoke
compilers, or manage OS processes.

Source: the installed `node_modules/@cloudflare/shell/README.md`.

The current project uses `Workspace` but not the broader state APIs, Code Mode,
Dynamic Workers, or pure-JS Git integration.

### `just-bash`

Cloudflare Think can provide a bounded Bash-like tool through `just-bash`. It
runs against the virtual workspace and supports common textual shell workflows
without a container.

It is shell emulation, not a general Linux environment. It cannot provide
arbitrary native dependencies or complete CLI compatibility.

### Sandbox SDK

Sandbox provides a real container-based Linux environment with:

- Commands with stdout, stderr, exit codes, working directory, environment,
  timeout, and streaming.
- Background processes, process groups, logs, signals, and termination.
- Git operations.
- Persistent Python, JavaScript, and TypeScript interpreter contexts.
- File operations.
- Port exposure and preview URLs.
- Outbound-network controls.

Source:
[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)

A live Sandbox filesystem and its processes are tied to the container
lifecycle. Durable continuity requires backup/restore, R2-mounted storage, or a
durable workspace integration.

### Containers

Containers are the lower-level full-Linux runtime. They support custom images,
arbitrary binaries and languages, services, and process execution. Sandbox
provides a higher-level agent-oriented interface over this class of runtime.

### Cloudflare Workspace preview

`@cloudflare/workspace` is a separate preview project from
`@cloudflare/shell`. Its intended architecture keeps the authoritative
filesystem in Durable Object SQLite and offers two shell backends:

- A Dynamic Worker running `just-bash` against the durable filesystem.
- A container that mounts the durable filesystem through FUSE for real Linux
  execution.

The same workspace can use both backends. This is the closest available design
for combining cheap structured/text operations with real Linux execution over
one durable file tree.

The project explicitly describes itself as preview-only, with unstable APIs,
and not suitable for production use.

Source:
[Cloudflare Workspace](https://github.com/cloudflare/workspace)

### Dynamic Workers and Code Mode

Dynamic Workers can execute generated JavaScript in isolated Worker runtimes
with controlled bindings, resource limits, and network policy.
`@cloudflare/codemode` lets generated code orchestrate coarse tools such as
`state.*` without exposing host secrets directly.

This is useful for structured orchestration but does not replace native Linux
commands.

### Durable execution

Cloudflare offers several durability levels:

| Need | Platform primitive |
| --- | --- |
| Real-time state and WebSockets | Agent/Durable Object |
| Recoverable agent turn | Agents fibers or Think recovery |
| Durable accepted work with idempotency | Think submissions |
| Multi-step jobs and external waits | Workflows |
| Scheduled work | Agent schedules or Workflows |

The current prompt call is not wrapped in a durable recovery primitive.

### Authentication and isolation

The current Worker has no authentication or authorization logic before Agents
routing. Cloudflare Access can protect the service, while application auth can
provide explicit user IDs for naming user, workspace, and session resources.

Named Durable Objects are not themselves an authorization boundary. A server
must derive or validate object names from authenticated identity.

## Features That Are Not Pi Parity

The following may be valuable product features, but they should not be
described as restoring Pi behavior:

- Automatic learned memory.
- Semantic cross-session recall.
- Cloudflare Session writable memory blocks.
- Model-facing `session_search` tools.
- MCP integration.
- Built-in sub-agents.
- Plan mode or to-do management.
- Human approval prompts.
- Browser automation.
- Durable background workflows.

Pi can gain many of these through extensions, but they are not part of its
default coding-agent behavior.

## Architectural Boundaries Identified by the Audit

The research exposes three distinct implementation directions. No direction is
selected here.

### Preserve Pi semantics

Use Pi's `AgentHarness`, implement Pi's `SessionStorage` contract with Durable
Object SQLite, and adapt `@cloudflare/shell` to Pi's execution environment.
This preserves Pi entries, explicit leaves, compaction, queues, and branching.

### Use Cloudflare-native semantics

Use Think and the Cloudflare Session API. This provides a broad feature set and
durable recovery with less custom infrastructure, but replaces Pi's runtime and
session semantics.

### Hybrid Pi on Cloudflare

Keep Pi's loop and session semantics while using Cloudflare Agents for durable
identity and transport, `@cloudflare/shell` for files, AI Gateway for model
routing, and optionally Sandbox for native execution. This keeps the product
faithful to its name but requires the missing session and runtime adapters.

## Open Product Questions

The following questions should be resolved before an implementation plan is
finalized:

1. Is the objective exact Pi runtime semantics or equivalent browser-facing
   capabilities?
2. Should each chat own its files permanently, despite Pi sharing a working
   directory across sessions?
3. Is lexical Pi-style session search sufficient, or is semantic recall an
   additional product requirement?
4. Should context remain explicit and user-authored like Pi, or should the
   model maintain writable memory blocks?
5. Is shell emulation sufficient, or are native package managers, tests,
   compilers, and preview servers required?
6. Are Pi-compatible extensions in scope, or are Cloudflare-native skills and
   extensions acceptable?
7. Which experimental Cloudflare APIs are acceptable for this project?

## Primary Sources

### Pi

- [Pi coding agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Sessions](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/sessions.md)
- [Session format](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/session-format.md)
- [Compaction](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/compaction.md)
- [Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)

### Cloudflare

- [Agents](https://developers.cloudflare.com/agents/)
- [Sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)
- [Think](https://developers.cloudflare.com/agents/harnesses/think/)
- [Think tools](https://developers.cloudflare.com/agents/harnesses/think/tools/)
- [Durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)
- [Sandbox](https://developers.cloudflare.com/sandbox/)
- [Containers](https://developers.cloudflare.com/containers/)
- [Workflows](https://developers.cloudflare.com/workflows/)
- [Cloudflare Workspace preview](https://github.com/cloudflare/workspace)
