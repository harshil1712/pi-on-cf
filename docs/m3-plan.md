# M3: the async loop

Pi keeps working after you leave: it tells you when it's done, answers PR reviews and fixes CI failures, and starts work from GitHub and other systems. This plan builds on the current state, `main` at `ab567ff`.

## Starting point

- `PiRegistry` (`src/server/pi-registry.ts`) is the singleton session catalog. Each entry's metadata holds name, title, repo, branch, pull request and run status (`running` or `failed`, absent while idle). A revision in its Agent state syncs every change to open pages.
- `PiSession` (`src/server/pi-session.ts`) reports run status changes to the registry from one event watch (`#watchStatus`), and `submit(prompt)` is durable through pi-durable.
- GitHub access is a fine-grained PAT, `env.GITHUB_TOKEN`, used through `PiSession.githubToken()` and in `PiRegistry.listRepositories`. `src/server/github.ts` has the REST helpers, and `src/server/task.ts` has `clone_repository` and `create_pull_request`, which pushes with `onAuth`.
- HTTP goes through `src/server.ts`: `routeAgentRequest`, then TanStack Start. The whole Worker is behind Cloudflare Access.
- Commits are by `Pi <pi@cloudflare.invalid>` (`GIT_IDENTITY` in pi-session.ts).

## Order

| # | Step | Depends on | Size |
|---|---|---|---|
| 1 | A. Notifications in the app | — | S |
| 2 | GitHub App foundation: auth, webhook endpoint, bot identity | — | M |
| 3 | B. PR feedback reaches the session | 2 | M |
| 4 | C. CI auto-fix | 2, 3 | M |
| 5 | E. Start tasks from GitHub: labels and `@pi` | 2 | S–M |
| 6 | External triggers (generic `/webhooks/<source>`) | 5 | M |
| — | D. Scheduled tasks | later | S |

Each step ships on its own: tests, `npm run check`, a browser check, then a commit.

---

## 1. A: notifications in the app (stage 1 only)

Goal: you can tell which sessions finished or failed since you last looked, without keeping each one open.

**Server**
- Registry metadata gains `finishedAt` (ISO), set by `setStatus` when a status changes from `running` to `idle` or `failed`, and `seenAt` (ISO).
- A new callable, `markSeen(sessionId)`, sets `seenAt` to now and bumps the revision. It must not move the session in the list: the SDK's `setMetadata` bumps `updatedAt`, so check whether `RoutedAgents` can write metadata without touching it. If it can't, `markSeen` changes ordering, so decide whether that's acceptable or keep `seenAt` in the registry's own SQLite table.
- `SessionSummary` gains `unread: boolean`, which is `finishedAt > (seenAt ?? 0)`.

**Client**
- The session page calls `markSeen` when it opens, and again when the run ends while the tab is visible (`document.visibilityState`).
- The sidebar shows an unread dot, distinct from the running dot (`text-kumo-brand`, or bold text), with sr-only "(unread)".
- The tab title becomes `(n) Pi` while n sessions are unread (`document.title` from the registry context).
- Browser notifications:
  - Ask permission only from a button, because browsers require a user gesture. Put it in the sidebar footer or the first time a run finishes.
  - On a list update, a session that moved from running to idle or failed raises a `Notification` with its title and "finished" or "failed", but only if the tab is hidden or that session isn't open. Clicking it focuses the window and navigates to the session.
  - Every open tab receives the update, so to notify once, use a `BroadcastChannel` lock, or notify only from the visible or most recently focused tab.

**Tests:** worker tests for `finishedAt`, `markSeen` and `unread`. A unit test for the sidebar unread dot and the title count. A unit test for the notification decision, as a pure function from previous and next lists plus visibility to the notifications to raise.

**Out of scope:** email and Web Push (stage 2).

---

## 2. GitHub App foundation

Why an App rather than the PAT:
- One webhook covers every installed repo.
- Short-lived installation tokens, limited to the installed repos, replace a 90-day PAT.
- A bot identity, so commits, PRs and comments come from `pi-on-cf[bot]`.
- Pushes with an installation token do trigger workflows; pushes with Actions' own `GITHUB_TOKEN` don't.

**App settings** (created once by the user; give step-by-step instructions)
- Permissions:
  - Contents: Read and write
  - Pull requests: Read and write
  - Issues: Read and write (comments and labels)
  - Checks: Read
  - Actions: Read (job logs)
  - Commit statuses: Read
  - Metadata: Read
  - Optional: Workflows, Read and write, to let Pi edit `.github/workflows`
- Subscribed events: Pull request, Pull request review, Pull request review comment, Issue comment, Issues, Check suite, Installation, Installation repositories.
- Webhook URL: `https://<worker>/webhooks/github`, with a webhook secret.
- Installed on "Only select repositories".

**Secrets and vars**
- `GITHUB_APP_ID` (var).
- `GITHUB_APP_SLUG` (var), for the bot login `<slug>[bot]` and `@`-mention matching.
- `GITHUB_APP_PRIVATE_KEY` (secret). GitHub issues PKCS#1 (`BEGIN RSA PRIVATE KEY`), but Web Crypto `importKey('pkcs8')` needs PKCS#8. Document the conversion, `openssl pkcs8 -topk8 -nocrypt -in key.pem`, rather than converting in code.
- `GITHUB_WEBHOOK_SECRET` (secret).
- Replace `secrets.required: ["GITHUB_TOKEN"]` in `wrangler.jsonc`. Decide whether to keep the PAT as a fallback during migration; the simplest option is to drop it once the App works.

**Code** (`src/server/github-app.ts`, no new dependencies)
- `appJwt(env)`: an RS256 JWT with `iat` 60s in the past and `exp` 9 minutes ahead, signed with `crypto.subtle`.
- `installationToken(env, repo)`:
  1. `GET /repos/{owner}/{repo}/installation` gives the installation id.
  2. `POST /app/installations/{id}/access_tokens` gives a token that lasts 1 hour.
  3. Cache it in memory per installation until about 5 minutes before expiry. In the registry or session DO is fine; it's cheap to fetch again.
- `listRepositories`: `GET /installation/repositories` for each installation (`GET /app/installations`). This replaces the PAT version in `PiRegistry.listRepositories`.
- `PiSession.githubToken()` becomes async and per repo: the installation token for `state.task.repo`. `clone_repository` fetches one for the repo it's about to clone. Check every caller in `task.ts`.
- **Bot identity:**
  1. `GET /users/{slug}[bot]` gives the bot's user id.
  2. The commit email is `{id}+{slug}[bot]@users.noreply.github.com`, and the name is `{slug}[bot]`.
  3. `defaultGitIdentity` is static, set when the Workspace is built. Either resolve the identity once and store it in session storage, or set `user.name`/`user.email` in the repo's `.git/config` at clone time through the workspace git's `config set`. The second is per repo and needs no Workspace change. Update `GIT_IDENTITY` and the preamble line to match.

**Webhook endpoint** (`/webhooks/github` in `src/server.ts`, before `routeAgentRequest`)
- Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the webhook secret, compared in constant time). Reject with 401 otherwise.
- Answer 202 straight away; GitHub times out after 10 seconds. Hand the event to the registry (`registry.handleGitHubEvent(event, deliveryId)`) under `ctx.waitUntil`, or better, through the Agent's `queue()` so it retries.
- Deduplicate on `X-GitHub-Delivery`. Store recent ids in the registry's SQLite with a TTL, because GitHub redelivers.
- **Access:** the user adds an Access application for the path `/webhooks/*` with a Bypass policy, so GitHub can reach it. Document this. The signature is the only authentication there.
- **Local dev:** GitHub can't reach `localhost`. Use a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) or the App's "Redeliver" button against a tunnel URL. Document whichever you use.

**Tests**
- A unit test for the JWT shape and signature, with a test key generated in the test.
- Webhook signature checks: valid, invalid, missing.
- Deduplication.
- The token cache, with `fetch` stubbed.
- A worker test where `clone_repository` gets its token through a stubbed installation lookup (extend `useGitHubTokenForTest` in `test/worker/entry.ts`).

---

## 3. B: PR feedback reaches the session

**Principle** (Cursor's subscriptions, Devin, Copilot): a webhook only wakes the session with a short note. Pi then reads the PR itself with tools and acts on its current state. Bursts of events merge into one wake-up.

**Routing**
- Registry metadata already has `repo`, `branch` and `pullRequest.number`. Find the session by `repo` plus PR number (or head branch). For a single user, scanning the entries is fine; add an index only if needed.
- Events that matter:
  - `pull_request_review` (submitted)
  - `pull_request_review_comment` (created)
  - `issue_comment` (created, on a PR)
  - `pull_request` (closed or merged, and synchronize from someone other than Pi)
- **Ignore the bot's own events** (`sender.type === 'Bot'` or `sender.login === '<slug>[bot]'`), or Pi would wake itself.

**Trust**
- Only events from trusted users wake Pi. Trusted means the App installation's account login, or an allowlist var `GITHUB_TRUSTED_USERS`.
- The tools still return untrusted comments, marked `trusted: false`, and the preamble tells Pi never to follow instructions from untrusted comments.
- Comments from others are shown in the session (as a note in the transcript, or just through the tools) but never sent to Pi as instructions.

**Merging bursts**
- `PiSession.notifyActivity(note)` appends the note to a pending list in storage, then `schedule(30 seconds, 'flushActivity')`. If one is already scheduled, it just appends.
- `flushActivity` submits a single prompt, for example "New activity on PR #12: 2 review comments and 1 review from harshil1712. Read it with pull_request_activity, address what's asked, push with create_pull_request, and reply on the PR." While Pi is running, `submit` becomes a steer, which is fine.

**New tools** (in `task.ts`, available only once a PR exists)
- `pull_request_activity({ since? })` returns:
  - Reviews: state and body.
  - Review comments: path, line, `diff_hunk`, body, author, `trusted`, id, `in_reply_to`.
  - Issue comments.
  It keeps a cursor in session state, so by default it returns what's new since the last read.
- `reply_to_pull_request({ body, inReplyTo? })` posts a PR comment, or replies in a review-comment thread (`POST /pulls/{n}/comments/{id}/replies`).
- `sync_branch()` fetches the PR branch and the base branch with the installation token (workspace git `fetch`/`pull` with `onAuth`, the same way `create_pull_request` pushes), and fast-forwards or merges commits you pushed. Computer's git has `merge` but no rebase, so say so in the tool's description.

**PR closed or merged:** record it in the task (`pullRequest.state`), stop waking on events, and show it in the sidebar. Archiving can come later.

**Tests:** the faux model with webhook payload fixtures (`test/worker/fixtures/github/*.json`):
- A trusted review leads to exactly one submitted prompt after merging.
- The bot's own event is ignored.
- An untrusted comment doesn't wake Pi.
- The tools return the `trusted` flag.
- `sync_branch` against a local bare repo, if Computer's test setup allows one, as `computer-test.ts` does.

---

## 4. C: CI auto-fix

**Trigger:** a `check_suite` webhook with `action: completed` and `conclusion: failure`, where `head_branch` and the repo match a session's PR branch.

**Guards** (all must pass; these follow Cursor's):
1. The head commit is Pi's: its author email is the bot's. Pi never auto-fixes commits you pushed.
2. The session isn't running.
3. You haven't sent the session a message since the failure.
4. The same check isn't also failing on the base branch: look at check runs for the base branch's head SHA, and skip with a note if it fails there too.
5. This PR has had fewer than `CI_FIX_LIMIT` attempts (default 3), counted in session state.
6. Auto-fix isn't switched off. A PR comment `@pi autofix off` / `@pi autofix on` from a trusted user toggles it, stored in session state.

When the limit is reached, set a session flag ("needs you"), which shows as failed or unread in the sidebar, and post a PR comment saying so.

**What Pi gets:** a short note, "CI failed on PR #12 at abc1234: `test (node 22)`, `lint`. Read the failures with ci_failures, fix them, and push."

**New tool:** `ci_failures({ sha? })`
1. `GET /repos/{o}/{r}/commits/{sha}/check-runs` lists the failed check runs.
2. For each Actions run, `GET /actions/runs/{run_id}/jobs` gives the failed jobs and steps.
3. `GET /actions/jobs/{job_id}/logs` follows a redirect to plain text. Return the last ~200 lines of each failed job.
4. For check runs from other apps, return `output.title`, `summary` and `text`.

Pi then fixes the code, commits and calls `create_pull_request`, which pushes and updates the PR. The new commit triggers CI again, and the loop repeats until CI is green or the limit is hit.

**Tests:** fixtures for `check_suite` and the check-run and job APIs (stubbed `fetch`). Cover each guard, plus the attempt counter and the toggle.

---

## 5. E: start tasks from GitHub

- **Label:** `issues` with `action: labeled` and the label `pi`, on an installed repo, from a trusted user.
  - The registry runs `createSession({ prompt })`. The prompt holds the issue title, body and URL, plus an instruction: work in `@owner/repo`, open a draft PR that references `Fixes #n`, and comment the PR link back on the issue.
- **Mention:** an `issue_comment` that contains `@<slug>` from a trusted user.
  - On an issue with no session, start one, as for the label.
  - On a PR that already has a session, route the comment to that session as feedback (step 3).
  - On a PR with no session, start a session on that PR's branch. That needs `clone_repository` to accept an existing branch, so `pull_request_head` should become an option.
- React to the triggering comment with 👀 (`POST /reactions`) so you can see it was picked up, then comment the PR link when it's ready.
- **Idempotency:** store `origin: { source: 'github', externalId: 'owner/repo#issue/123' }` in the session metadata. A second label or mention on the same issue routes to the existing session instead of starting a new one.
- A new tool, `comment_on_issue({ body })`, available when the session has a GitHub origin. Or fold it into `reply_to_pull_request` as `comment({ target })`.

---

## 6. External triggers (e.g. Cloudflare Issues, Jira)

**Open question:** which system is "Cloudflare Issues"? Internal Jira, or something else? It decides how requests are verified and how results are posted back.

**Shape:** a generic endpoint, `POST /webhooks/<source>`, where each source is an adapter:

```ts
interface TriggerSource {
  name: string
  verify(request: Request, body: string, env: Env): Promise<boolean>   // HMAC, shared secret, or JWT
  parse(body: unknown): { externalId: string; repo?: string; prompt: string; url?: string } | null
  reply?(env: Env, externalId: string, message: string): Promise<void> // post the PR link or a summary back
}
```

- The registry gets `startFromTrigger(source, parsed)`, which creates the session at most once per `source:externalId` and stores `origin` in the metadata.
- When the session opens a PR, or a run finishes for the first time, the session calls the adapter's `reply` with the PR link or a summary.
- If the issue doesn't name a repo, the prompt says to ask, or there's a default repo per source (a var).
- Signatures depend on the source: Jira Cloud webhooks can carry a secret, giving an HMAC signature; a generic source uses a shared bearer secret.
- Each source path needs an Access bypass, like `/webhooks/github`.
- Tests: a fake adapter, covering verify failure, idempotency and reply on PR.

---

## Decisions carried over

| Question | Answer |
|---|---|
| Notifications | Stage 1 only, in the app. |
| PR feedback transport | Webhooks through a GitHub App, no polling. |
| What reaches Pi | Short notes, after which Pi reads the PR with tools (Cursor's model). |
| Trust | Only trusted users wake Pi. Other content is marked untrusted. |
| CI auto-fix | Guarded as Cursor does, with a limit of 3, and toggled by `@pi autofix off/on`. |
| Ordering | Sessions are ordered by their latest state; status changes move them up. |

## Open questions for the user

1. Which system is "Cloudflare Issues", and can it send signed webhooks?
2. Is an Access bypass for `/webhooks/*` acceptable?
3. Should commits be by `pi-on-cf[bot]` (recommended with the App), or by you with a `Co-authored-by: Pi` trailer?
4. Should the PAT stay as a fallback after the App lands, or be removed?
5. Should auto-fix be on by default, with a limit of 3?
6. Should a merged or closed PR archive its session?

## Useful references

- Cursor subscriptions and CI auto-fix: https://cursor.com/docs/cloud-agent/capabilities.md
- Devin GitHub integration: https://docs.devin.ai/integrations/gh
- Copilot on existing PRs: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/make-changes-to-an-existing-pr
- GitHub App auth: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
- Webhook signatures: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Computer git interface: https://github.com/cloudflare/computer/blob/main/docs/13_git_interface.md
