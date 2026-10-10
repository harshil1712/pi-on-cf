# Pi on Cloudflare Architecture

This document describes the current Pi on Cloudflare system design and its known limitations. It reflects the migration to `@earendil-works/pi-durable` 1.0, `agents` 0.26, and `@cloudflare/computer` 0.4.

## System Overview

Pi on Cloudflare is a TanStack Start application deployed as a Cloudflare Worker. It combines:

- Pi's durable harness, `@earendil-works/pi-durable`, hosted by the Agents SDK's `PiHarness` (`agents/harness/pi`).
- Workers AI and AI Gateway through `agents/models/pi-ai` and the `AI` binding.
- One `PiSession` Durable Object per session, owning the Pi conversation and a Cloudflare Computer workspace.
- A singleton `PiRegistry` Durable Object for the session catalog, on the Agents SDK's `RoutedAgents` (`agents/routing`).

The Worker routes `/api/agents/*` through the Agents SDK and sends other requests to TanStack Start. Sessions are reachable only through the registry: `src/server/agent-routes.ts` refuses direct `/api/agents/pi-session/*` requests. Every page sits in one app shell (`src/components/app-shell.tsx`): Kumo's `Sidebar` lists the sessions beside the routed page, a home page at `/` starts sessions from a prompt, and each session's workspace is at `/sessions/:sessionId`. The shell holds the app's one registry connection (`SessionRegistryProvider`), which both pages share.

The UI is written mobile-first: the layout below `md` is the baseline and `md:`/`lg:` utilities add the desktop arrangement, never the other way around. On a phone the sidebar becomes an offcanvas sheet, and tapping a file or change opens its preview or diff full-screen with a back button, instead of the desktop's shared panel. The session page puts Chat and Workspace side by side only when the page itself is at least 56rem wide, measured with a container query (`@container` on its `main`, `@4xl:` utilities), not the window: on a tablet the open sidebar takes 260px, which would leave the chat a sliver. Narrower, Chat and Workspace are tabs. A dot on the Workspace tab, and on the Workspace button beside the chat, points out pending changes. The viewport meta and the `useKeyboardAwareHeight` hook keep the composer above the soft keyboard, safe-area padding keeps it off the notch, and the web manifest with generated icons (`scripts/generate-icons.mjs`) makes the app installable.

Relevant source:

- `src/server.ts`
- `src/contract.ts`
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
- `clone_repository`, `create_pull_request`, `comment_on_github`, `create_github_issue`, and `read_github_issue` (see [Repositories](#repositories));
- the skill tools `open_skill`, `save_skill`, and `delete_skill` (see [Skills](#skills));
- the web tools (see [Web](#web)).

Tool calls in a round run sequentially. Reads, searches, `write`, and `delete` are marked replay-safe; `edit` and `exec` are reported to the model as interrupted if an eviction cuts them off.

### Web

The web tools come from the Agents SDK's pi adapters (`createWebTools` in `src/server/web-tools.ts`). The preamble's line on the web lists the tools the session has:

- `web_fetch` (`agents/webfetch/pi`) reads a URL as Markdown, converted by `env.AI.toMarkdown()` when needed, in windows that keep long pages out of the transcript; it is a replay-safe read.
- `web_search` (`agents/websearch/pi`) searches the Web Search API when `WEB_SEARCH_PROVIDER` is set, billed to the provider key `WEB_SEARCH_BYOK_ALIAS` names, or to AI Gateway credits without one; the README explains the key setup. A search bills whoever the gateway says, per search.
- `browser` (`agents/browser/pi`), with a `BROWSER` binding, drives the session's own persistent browser, a `Browser` on the Lifecycle over the `BROWSER` Browser Run binding. Tabs, cookies and logins carry over between runs; screenshots come back as image parts for models that accept them. The tool's codemode runtime is a facet of the session's Durable Object, exported from `src/server.ts`, and teardown closes the browser after the harness.

The app watches what the session watches. The Workspace panel's Browser view (the globe in the top bar opens it) embeds Live View of Pi's tabs, page only (`mode: 'tab'`), so the chat stays usable beside it: `browserLiveView()` lists the tabs that aren't `about:blank`, opening the view or reconnecting mints fresh URLs (each connects for about five minutes), and each finished browser call lists them again, keeping the frame's connection unless Pi opened a new tab, which the view follows. The transcript shows the screenshots a browser run returns, as data URLs under the tool call, visible with its card collapsed. They are not links: browsers refuse to open a data: URL in a new tab.

The model comes from `createAI({ binding: env.AI })`. New sessions start on `AI_MODEL` at the `medium` thinking level. The composer's model picker switches a session to any model in the curated list in `src/server/models.ts`, with `AI_MODEL` added when the list lacks it: `setModel` checks the ID against that list, calls pi's `session.setModel`, and records the ID in the Agent state, which the picker shows. Pi uses the new model from its next request. The UI only offers the switch while the session is idle; pi itself would accept it mid-run. The home page's picker reads the same list, default first, from the registry's `listModels`; `createSession({ prompt, model })` checks the model against it before creating an entry, then sets it on the new session before submitting the prompt.

### Transport

The browser connects to `/api/agents/pi-registry/singleton/sessions/{id}`, which the registry forwards to the session's Agent; the Agent then owns the socket, so session traffic never wakes the registry. `PiSession` sets `sendIdentityOnConnect: false`, so its physical name never reaches the browser.

Commands are `@callable` methods: `submit`, `steer`, `abort`, `listFiles`, `readWorkspaceFile`, `listChanges`, `readChange`, `listModels`, and `setModel`. `submit` resolves once Pi has durably accepted the prompt, before the model runs.

Each WebSocket connection gets its own `session.events()` watch. The first frame is a `snapshot`; each later frame is one batch of Pi agent events per commit. The client folds them with the reducer in `src/lib/transcript.ts`. Watches live in memory, so `onStart` re-watches every connection that outlived the previous isolate and sends a fresh snapshot. A reconnecting browser always starts from the current state, including an in-flight answer.

### Run status

Each session also keeps one watch of its own, tied to no connection, that folds its events into a run status with `reduceRunStatus` in `src/lib/run-status.ts`: `running` from `run_start`, `idle` after `run_end`, and `failed` when pi settles the run's inputs `unanswered` (a model error, a faulted or orphaned task) in the same batch as its `run_end`; an abort or a withdrawn steer is not a failure. The browser's transcript reducer shares the same `unansweredReason` test for its error. `failed` sticks until the next `run_start`. The session stores the status it last recorded and calls the registry's `setStatus` only when it changes.

`onStart` opens that watch, so it runs on whatever wakes a new isolate, the alarm included. After an eviction mid-run the Lifecycle starts `PiHarness`, which re-arms its wake job, then runs `onStart`, before the wake job runs; opening pi for the watch resets interrupted tasks to pending and resumes the scheduler, and the run carries on without a new `run_start`. The watch's first snapshot therefore always goes to the registry: it shows a pending run as `running`, and turns a recorded `running` whose run is gone into `idle`. The registry ignores a report of the status it already has.

### Workspace

The Computer workspace is rooted at `/workspace` and has three `exec` backends:

| Backend | Runtime |
| --- | --- |
| `shell` | Worker Shell: just-bash with text utilities and git, in a Dynamic Worker |
| `javascript` | Worker JavaScript: ES modules with `node:fs/promises`, `ws:git`, and `ws:artifacts` |
| `container` | `ContainerBackend`: a Durable Object-scheduled Cloudflare Container running `computerd`, with direct egress |

The container dials back to the object at `/api` through `WorkspaceProxy`; `PiSession.fetch` hands that upgrade to the backend. The workspace also has git and session Artifacts. Git follows Computer's recommended setup: `createGitClient()` (isomorphic-git) on the workspace, behind the shell backend's `git` command and `ws:git`, committing as the GitHub App's bot, `<slug>[bot]` with its `users.noreply.github.com` address, through `defaultGitIdentity`, built from `GITHUB_APP_SLUG` and `GITHUB_APP_BOT_ID`. The exec tool's backend descriptions and the preamble send git to the shell backend. The container image keeps git, as Computer's agent examples do, for tools that read the repository; it has no identity, so a commit there fails instead of bypassing the workspace's. The image sets `EXEC_SHELL=/bin/bash`, so container commands support `set -o pipefail`, which the preamble suggests so piped test and build output keeps its exit code.

### Repositories

A session working on a repository holds a task in its Agent state: the repository, the base branch and commit, the task branch `pi/<entry id prefix>`, the clone's directory and, once opened, the pull request. The Agents SDK syncs that state to the session's clients; `validateStateChange` refuses client writes, so only the server sets the branch that gets pushed.

The model opens a task by calling `clone_repository`, so a session that only discusses a repository, or needs nothing from it, never clones. The composer suggests the repositories of the App's installations on `GITHUB_OWNERS` accounts after `@`, most recently pushed first, from the registry's `listRepositories` callable, so the home page can suggest them before a session exists; a mention is plain text, and the `repository` prompt section tells the model what `@owner/name[#branch]` means and to clone only when it needs the code. The tool reads the default branch from the GitHub API unless the model names one, without checking push access, since a clone may only be read, clones with full history on one branch with Computer's git client and the token in per-call headers, records `HEAD` as the base commit, and checks out the task branch. A failed clone removes the partial directory and goes back to the model as a tool error. A session clones one repository: asking for the same one again reports the clone, which makes a replayed call safe, and another is refused. The registry copies the repository, branch and pull request into the entry's metadata for the catalog.

The `repository` prompt section renders before every request from the task and the clone's `AGENTS.md`. `create_pull_request` refuses uncommitted changes, pushes only the task branch with the token passed to `push`'s `onAuth`, then finds the open pull request for that branch and updates it, or opens a draft one; the lookup makes a replay safe. The pull request goes into the session's state and, for the catalog, the registry's metadata.

GitHub access goes through the App (`src/server/github-app.ts`): `@octokit/auth-app` signs the App's JWT and mints installation tokens, which it caches in the isolate until shortly before they expire. `PiSession.githubToken(repo)` finds the repository's installation, refuses it unless it is on an account in `GITHUB_OWNERS`, and returns a token limited to that one repository. The token never reaches the workspace's git configuration or the container, so `git push` from the agent's shell fails. `comment_on_github` posts on the session's pull request, or on the issue a mention started it from, and keeps pi-durable's default `replay: 'unsafe'`, so an interrupted call is never run again and never posts twice. `create_github_issue` opens an issue, unsafe for the same reason, and `read_github_issue` reads an issue or pull request with up to 300 comments. Both work on the repository the model names, else the session's, else the issue's, with that repository's token, so the App must be installed there with Issues: Read and write.

`src/server.ts` sends `/webhooks/github` to `handleGitHubWebhook` before any other route. It verifies the `X-Hub-Signature-256` HMAC with `@octokit/webhooks-methods` against `GITHUB_WEBHOOK_SECRET`, answers 401 otherwise, and keeps only new issue and review comments that mention `@<slug>` from a user in `GITHUB_OWNERS`, never from a bot. A mention goes to the registry's `receiveGitHubMention`, which queues it with the Agent's durable `queue()`, keyed by the delivery ID, and the endpoint answers 202. `handleGitHubMention` then finds the session by the entry's repository and pull request number, or the issue it started from (`thread` in the entry's metadata), and submits a follow-up prompt; a mention on an issue without a session creates one, titled after the issue, whose session stores the issue so `comment_on_github` can answer there. It reacts 👀 to the comment, or 😕 on a pull request without a session; a failed reaction is only logged. `listChanges` and `readChange` diff the working tree against the base commit with `diffSummary` and `diff`, so uncommitted work shows too.

### Artifacts

The workspace's Artifacts client is scoped to the session's Durable Object ID, so the repos the agent creates through `ws:artifacts` are named under it. Teardown lists and deletes them, since they live outside the object's storage.

### Skills

The harness installs the Agents SDK's Agent Skills into Pi's skill registry, which adds `activate_skill` and `read_skill_resource` and puts each skill's name and description in the system prompt. `PiSession.skillSources()` lists three sources, and an earlier source wins a name:

1. Built-in skills, bundled from `src/server/bundled-skills` by the Agents Vite plugin (`agents:skills`). The only one is `skill-creator`.
2. The cloned repository's skills: `<name>/SKILL.md` under `.agents/skills`, `.claude/skills`, `.pi/skills`, then `.github/skills`. The SDK has no source that reads a filesystem, so `repoSkills` in `src/server/repo-skills.ts` reads them, with their files, into a manifest for the SDK's `fromManifest()` source. A manifest is fixed, so it reads the repository again on every refresh and swaps in a new one: a clone, or a skill the agent writes, shows up at the next sync, and `clone_repository` syncs at once. Each body is prefixed with the skill's path, so the agent can run its scripts with `exec`.
3. Shared skills, read from `skills/` in the `BUCKET` R2 bucket with the SDK's `r2()` source.

The SDK freezes a catalog when it builds it, so `SkillCatalog` in `src/server/skills.ts` refreshes the sources when the harness opens and, in the background, after each accepted prompt, and reinstalls the catalog when a source's fingerprint changes. The bucket is listed at most once a minute.

The agent manages shared skills with three tools in `src/server/skill-tools.ts`, using the ordinary file tools in between:

- `open_skill` copies a shared skill's raw files from the bucket into `/workspace/skills/<name>/`, replacing any draft there.
- `save_skill` publishes `/workspace/skills/<name>/` to `skills/<name>/`. It checks the name against the Agent Skills specification and the `SKILL.md` frontmatter and refuses built-in names, then writes new files first and `SKILL.md` last and deletes stale files, so a skill being replaced never disappears.
- `delete_skill` deletes `skills/<name>/`.

After a save or delete, `SkillCatalog.reload()` rebuilds the session's sources, so the session sees the change from its next model call instead of after the bucket source's refresh interval. Other sessions pick it up on their next refresh.

## PiRegistry

The singleton `PiRegistry` keeps the session catalog with the Agents SDK's `RoutedAgents` capability: each entry maps a public session ID to an opaque physical `PiSession` name, with an optional session name as metadata and timestamps. Creating, listing, and renaming touch only the registry's SQLite. Creating a session also calls `joinCatalog` on the new `PiSession`, which stores the entry ID it reports activity under; a `PiSession` touches its entry when it accepts a prompt, which moves it to the top of the list, and the first prompt it accepts titles an entry that has none (`titleFromPrompt` in `src/server/session-title.ts`). The catalog shows a session's name, else its title, else its repository. The home page starts a session from a prompt: `createSession({ prompt })` submits it to the new session after `joinCatalog`, and a failed submit deletes the entry like a failed join.

Repository sessions also store the repository, the task branch and the pull request in the entry's metadata, so the catalog lists them without waking each session.

Each entry's metadata also holds the session's run status, absent while idle. `setStatus` rewrites the metadata with its other fields kept, so a status change moves the entry to the top like a prompt, and the sidebar orders and groups sessions by their latest state. The sidebar shows a pulsing dot for a running session and a warning icon after a failed run.

The registry's Agent state is a revision that every catalog change bumps: creating, renaming, deleting, titling, touching, a session's task or pull request, and a change in its run status. The Agents SDK syncs that state to every open page, which reloads the list when it moves, so the sidebar follows other tabs and running sessions without polling. Clients cannot write it.

Deleting a session hides the entry, condemns the `PiSession` through the Agents SDK's deferred teardown, then removes the row; a failed delete leaves a hidden row and can be retried. The teardown runs `destroy()` in the session's own alarm: Lifecycle disposal stops the session's event watches and its container, deletes its Artifacts repos, closes Pi, and then the Agent wipes Pi's tables and the workspace.

## Security Model

The application has no authentication or authorization. The GitHub App can write to every repository it is installed on, and any session can be pointed at any of them; install it only on the repositories you want Pi to work on. Each session's token is limited to its own repository. The App must be public to install on more than one account, so anyone can install it; installations on accounts outside `GITHUB_OWNERS` are ignored. The webhook endpoint bypasses Access, so the webhook secret is its only protection; a mention from a user in `GITHUB_OWNERS` directs Pi like a prompt in the app, and an untrusted author's issue description is quoted as information, but its text still reaches the model. A clone's `AGENTS.md` and its skills' descriptions go into the system prompt, so a repository you mention can steer the session. Pi reads repository content, including issues and files an attacker may control, and its container has network access, so treat its pull requests as untrusted until reviewed. Anyone who can reach a deployment can list, read, change, and delete every session and workspace, and run models on the account's AI binding. Session IDs are isolation mechanisms, not authorization boundaries. A shared skill's description is in every session's system prompt and its body instructs any session that activates it, so saving a skill, or writing to `skills/` in the bucket, can steer every session. The agent saves skills without review, so a prompt-injected session can plant a skill that steers the others. `RoutedAgents` supports one registry per user, which is where per-user isolation would start once the application authenticates users. Protect the whole Worker with Cloudflare Access or another authentication layer.

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
- Manual compaction, context reset, and thinking-level selection.
- Browser Run can only reach the public internet, so Pi cannot open the dev server it runs in its own container's localhost.
- Image input, usage and cost display.
- Sharing files by link. Computer's `publish` tool needs Assets, which the application does not configure.

## Verification

```bash
npm run check
npm run build
```

The Workers suite, in `test/worker`, runs a real `PiSession` with pi-ai's faux provider and two faux models: a plain answer, switching models, a model tool call that writes through Computer, the WebSocket snapshot, and the run status the registry lists, including a failed run and the correction a restart makes. It also exercises Computer's Worker Shell, git, Worker JavaScript, and the tool adapter, and repository tasks on a local repository: the `repository` section, changes against the base commit, read-only task state, and `create_pull_request`'s refusals. Live Workers AI inference, the container backend, GitHub itself, and Artifacts are not covered by tests.
