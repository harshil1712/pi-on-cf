# Pi on Cloudflare Architecture

This document describes the current Pi on Cloudflare system design and its known limitations. It reflects the migration to `@earendil-works/pi-durable` 1.0, `agents` 0.26, and `@cloudflare/computer` 0.4.

## System Overview

Pi on Cloudflare is a TanStack Start application deployed as a Cloudflare Worker. It combines:

- Pi's durable harness, `@earendil-works/pi-durable`, hosted by the Agents SDK's `PiHarness` (`agents/harness/pi`).
- Workers AI and AI Gateway through `agents/models/pi-ai` and the `AI` binding.
- One `PiSession` Durable Object per session, owning the Pi conversation and a Cloudflare Computer workspace.
- A singleton `PiRegistry` Durable Object for the session catalog, on the Agents SDK's `RoutedAgents` (`agents/routing`).

The Worker routes `/api/agents/*` through the Agents SDK and sends other requests to TanStack Start. Sessions are reachable only through the registry: `src/server/agent-routes.ts` refuses direct `/api/agents/pi-session/*` requests. The browser has a session catalog at `/` and a workspace at `/sessions/:sessionId`.

Relevant source:

- `src/server.ts`
- `src/shared/pi-contract.ts`
- `src/server/pi-session.ts`
- `src/server/pi-registry.ts`
- `src/server/agent-routes.ts`
- `wrangler.jsonc`

## PiSession

Each session ID is a `PiRegistry` catalog entry that names one `PiSession`, an Agents SDK `Agent` composed with two Computer mixins:

- `withWorkspaceContainer` makes the object the host of its own Computer container.
- `withWorkspace` builds the `Workspace` and serves it to Computer's Worker Shell through `__getWorkspaceStub`.

### Pi

`PiHarness` opens pi-durable over the object's SQLite, in tables prefixed `pi_`, and registers with the Agent's Lifecycle. Pi owns everything about a run: the transcript, the inbox of steers and follow-ups, generation and tool tasks, retries, automatic compaction, and crash recovery. While Pi has work, the harness keeps one Lifecycle job per session; if the object is evicted mid-run, that job's alarm restarts it and Pi resumes from its last commit. The application does not override `alarm()`.

The session uses Pi's root conversation. The harness factory installs one Pi extension containing:

- a `preamble` system-prompt section describing the workspace;
- Computer's tools from `createPiTools`, adapted to pi-durable tool registrations in `src/server/workspace-tools.ts`;
- a `repository` section describing the session's task and its `AGENTS.md`, when it has one (see [Repositories](#repositories));
- `clone_repository` and `create_pull_request` (see [Repositories](#repositories));
- the skill tools `open_skill`, `save_skill`, and `delete_skill` (see [Skills](#skills)).

Tool calls in a round run sequentially. Reads, searches, `write`, and `delete` are marked replay-safe; `edit` and `exec` are reported to the model as interrupted if an eviction cuts them off.

The model comes from `createAI({ binding: env.AI })`. New sessions start on `AI_MODEL` at the `medium` thinking level.

### Transport

The browser connects to `/api/agents/pi-registry/singleton/sessions/{id}`, which the registry forwards to the session's Agent; the Agent then owns the socket, so session traffic never wakes the registry. `PiSession` sets `sendIdentityOnConnect: false`, so its physical name never reaches the browser.

Commands are `@callable` methods: `submit`, `steer`, `abort`, `listFiles`, `readWorkspaceFile`, `listRepositories`, `listChanges`, and `readChange`. `submit` resolves once Pi has durably accepted the prompt, before the model runs.

Each WebSocket connection gets its own `session.events()` watch. The first frame is a `snapshot`; each later frame is one batch of Pi agent events per commit. The client folds them with the reducer in `src/features/workspace/transcript.ts`. Watches live in memory, so `onStart` re-watches every connection that outlived the previous isolate and sends a fresh snapshot. A reconnecting browser always starts from the current state, including an in-flight answer.

### Workspace

The Computer workspace is rooted at `/workspace` and has three `exec` backends:

| Backend | Runtime |
| --- | --- |
| `shell` | Worker Shell: just-bash with text utilities and git, in a Dynamic Worker |
| `javascript` | Worker JavaScript: ES modules with `node:fs/promises`, `ws:git`, and `ws:artifacts` |
| `container` | `ContainerBackend`: a Durable Object-scheduled Cloudflare Container running `computerd`, with direct egress |

The container dials back to the object at `/api` through `WorkspaceProxy`; `PiSession.fetch` hands that upgrade to the backend. The workspace also has git and session Artifacts.

### Repositories

A session working on a repository holds a task in its Agent state: the repository, the base branch and commit, the task branch `pi/<entry id prefix>`, the clone's directory and, once opened, the pull request. The Agents SDK syncs that state to the session's clients; `validateStateChange` refuses client writes, so only the server sets the branch that gets pushed.

The model opens a task by calling `clone_repository`, so a session that only discusses a repository, or needs nothing from it, never clones. The composer suggests the token's pushable repositories after `@`, from the `listRepositories` callable; a mention is plain text, and the `repository` prompt section tells the model what `@owner/name[#branch]` means and to clone only when it needs the code. The tool reads the default branch from the GitHub API unless the model names one, without checking push access, since a clone may only be read, clones shallow and single-branch with Computer's git client and the token in per-call headers, records `HEAD` as the base commit, and checks out the task branch. A failed clone removes the partial directory and goes back to the model as a tool error. A session clones one repository: asking for the same one again reports the clone, which makes a replayed call safe, and another is refused. The registry copies the repository, branch and pull request into the entry's metadata for the catalog.

The `repository` prompt section renders before every request from the task and the clone's `AGENTS.md`. `create_pull_request` refuses uncommitted changes, pushes only the task branch with the token passed to `push`'s `onAuth`, then finds the open pull request for that branch and updates it, or opens a draft one; the lookup makes a replay safe. The pull request goes into the session's state and, for the catalog, the registry's metadata.

The token never reaches the workspace's git configuration or the container, so `git push` from the agent's shell fails. `listChanges` and `readChange` diff the working tree against the base commit with `diffSummary` and `diff`, so uncommitted work shows too.

### Artifacts

The workspace's Artifacts client is scoped to the session's Durable Object ID, so the repos the agent creates through `ws:artifacts` are named under it. Teardown lists and deletes them, since they live outside the object's storage.

### Skills

The harness installs the Agents SDK's Agent Skills into Pi's skill registry, which adds `activate_skill` and `read_skill_resource` and puts each skill's name and description in the system prompt. `PiSession.skillSources()` lists two sources, and an earlier source wins a name:

1. Built-in skills, bundled from `src/server/bundled-skills` by the Agents Vite plugin (`agents:skills`). The only one is `skill-creator`.
2. Shared skills, read from `skills/` in the `BUCKET` R2 bucket with the SDK's `r2()` source.

The SDK freezes a catalog when it builds it, so `SkillCatalog` in `src/server/skills.ts` refreshes the sources when the harness opens and, in the background, after each accepted prompt, and reinstalls the catalog when a source's fingerprint changes. The bucket is listed at most once a minute.

The agent manages shared skills with three tools in `src/server/skill-tools.ts`, using the ordinary file tools in between:

- `open_skill` copies a shared skill's raw files from the bucket into `/workspace/skills/<name>/`, replacing any draft there.
- `save_skill` publishes `/workspace/skills/<name>/` to `skills/<name>/`. It checks the name against the Agent Skills specification and the `SKILL.md` frontmatter and refuses built-in names, then writes new files first and `SKILL.md` last and deletes stale files, so a skill being replaced never disappears.
- `delete_skill` deletes `skills/<name>/`.

After a save or delete, `SkillCatalog.reload()` rebuilds the session's sources, so the session sees the change from its next model call instead of after the bucket source's refresh interval. Other sessions pick it up on their next refresh.

## PiRegistry

The singleton `PiRegistry` keeps the session catalog with the Agents SDK's `RoutedAgents` capability: each entry maps a public session ID to an opaque physical `PiSession` name, with an optional session name as metadata and timestamps. Creating, listing, and renaming touch only the registry's SQLite. Creating a session also calls `joinCatalog` on the new `PiSession`, which stores the entry ID it reports activity under; a `PiSession` touches its entry when it accepts a prompt, which moves it to the top of the list.

Repository sessions also store the repository, the task branch and the pull request in the entry's metadata, so the catalog lists them without waking each session.

Deleting a session hides the entry, condemns the `PiSession` through the Agents SDK's deferred teardown, then removes the row; a failed delete leaves a hidden row and can be retried. The teardown runs `destroy()` in the session's own alarm: Lifecycle disposal stops the session's event watches and its container, deletes its Artifacts repos, closes Pi, and then the Agent wipes Pi's tables and the workspace.

## Security Model

The application has no authentication or authorization. `GITHUB_TOKEN` can write to every repository it grants, and any session can be pointed at any of them; limit the token to the repositories you want Pi to work on. The model can also clone any repository the token can read, public ones included, and a clone's `AGENTS.md` goes into the system prompt, so a repository you mention can steer the session. Pi reads repository content, including issues and files an attacker may control, and its container has network access, so treat its pull requests as untrusted until reviewed. Anyone who can reach a deployment can list, read, change, and delete every session and workspace, and run models on the account's AI binding. Session IDs are isolation mechanisms, not authorization boundaries. A shared skill's description is in every session's system prompt and its body instructs any session that activates it, so saving a skill, or writing to `skills/` in the bucket, can steer every session. The agent saves skills without review, so a prompt-injected session can plant a skill that steers the others. `RoutedAgents` supports one registry per user, which is where per-user isolation would start once the application authenticates users. Protect the whole Worker with Cloudflare Access or another authentication layer.

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

- Following a pull request after it opens: review comments, CI results, and pulling new commits from the base branch. The agent's git has no credentials, so it cannot fetch from a private repository.
- Environment setup per repository; the container starts from the same image for every session.
- Authentication and per-user isolation.
- Forks, clones, and session search.
- Long-term memory.
- Manual compaction, context reset, model and thinking-level selection.
- Image input, usage and cost display.
- Sharing files by link. Computer's `publish` tool needs Assets, which the application does not configure.

## Verification

```bash
npm run check
npm run build
```

The Workers suite, in `test/worker`, runs a real `PiSession` with pi-ai's faux provider: a plain answer, a model tool call that writes through Computer, and the WebSocket snapshot. It also exercises Computer's Worker Shell, git, Worker JavaScript, and the tool adapter, and repository tasks on a local repository: the `repository` section, changes against the base commit, read-only task state, and `create_pull_request`'s refusals. Live Workers AI inference, the container backend, GitHub itself, and Artifacts are not covered by tests.
