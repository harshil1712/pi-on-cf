# Pi on Cloudflare

A Worker-native coding agent. Pi runs in Cloudflare Durable Objects with a persistent Cloudflare Computer workspace, remembers its work across evictions, and can clone a GitHub repository, change it on a branch, and open a draft pull request.

> [!NOTE]
> Some packages, including PiHarness and parts of Cloudflare Computer, are beta. Their APIs and behavior may change between releases.

> [!WARNING]
> There is no application-level authentication or authorization. Anyone who can reach a deployment can use its AI binding and read, change, or delete its sessions and workspace files. Protect the entire Worker with Cloudflare Access or another authentication layer, exposing only the webhook paths.

## What it includes

- One `PiSession` Durable Object per session, with Pi's transcript, inbox, generation, tools, retries, compaction, and recovery in SQLite.
- A `PiRegistry` Durable Object for the session catalog and shared MCP connections. It is the only public route to a session.
- A durable `/workspace` with Worker Shell, Codemode, and a Durable Object-scheduled Linux container.
- Workers AI through AI Gateway. New sessions default to **DeepSeek V4.1 Flash** at **high** reasoning; **GLM 5.3** is also available.
- GitHub App cloning, branch pushes, draft pull requests, issue comments, and mentions.
- `web_fetch`, optional `web_search`, a persistent Browser Run browser, and a chat UI built with TanStack Start and Cloudflare Kumo.

See [the architecture guide](docs/architecture.md) for implementation details and [AGENTS.md](AGENTS.md) for contributor commands and conventions.

## Requirements

- Node 24 (`.node-version`), or another version allowed by `package.json`
- Docker, for the local Computer container
- A Cloudflare account authenticated with `npx wrangler login`
- Workers Paid or prepaid AI Gateway credits for the default model
- R2 and Browser Run enabled on that account
- A GitHub App for repository and mention features

## Local development

Install and start the app:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

Local development uses remote AI, R2, Artifacts, and Browser bindings. Create the bucket once:

```bash
npx wrangler r2 bucket create pi-on-cf
```

Local Durable Object state lives in `.wrangler/` and can contain transcripts and workspace files. Do not publish it. If the account's `workers.dev` subdomain is behind Cloudflare Access, local development asks you to authenticate; non-interactive environments need `CLOUDFLARE_ACCESS_CLIENT_ID` and `CLOUDFLARE_ACCESS_CLIENT_SECRET`, or a different account.

### Configuration

Set account-specific values in an ignored `wrangler.local.jsonc`, selected with `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=wrangler.local.jsonc` for Vite or `--config wrangler.local.jsonc` for Wrangler.

| Variable | Purpose |
|---|---|
| `AI_MODEL` | Initial model; currently `@cf/deepseek-ai/deepseek-v4.1-flash-1017`. Curated choices live in `src/server/models.ts`. |
| `AI_GATEWAY_ID` | AI Gateway used for model calls and web search. Defaults to `default`. |
| `WEB_SEARCH_PROVIDER` | Enables `web_search` when set; currently `exa`. Remove it to disable search. |
| `WEB_SEARCH_BYOK_ALIAS` | Provider-key alias on the gateway; currently `pi-search`. |

The seven required secrets below are declared in `wrangler.jsonc`. Deploying fails until all are set with `npx wrangler secret put <NAME>`. Set them locally in `.dev.vars` or `.env`.

| Secret | Purpose |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | App private key in PKCS#8 format |
| `GITHUB_APP_SLUG` | App URL slug |
| `GITHUB_APP_BOT_ID` | Numeric user ID of `<slug>[bot]` |
| `GITHUB_OWNERS` | Comma-separated users and organizations whose installations and mentions Pi may use |
| `GITHUB_WEBHOOK_SECRET` | Secret used to verify GitHub webhook signatures |
| `WEBHOOK_SECRET` | Shared secret for `/webhooks/generic`; set one even when unused |

Only the private key and webhook secrets are sensitive; the other values are deployment-specific.

## GitHub App

1. [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app). Give it **Contents**, **Pull requests**, and **Issues** read/write repository permissions. **Workflows** read/write is optional and only needed to edit workflow files. Subscribe to **Issue comment** and **Pull request review comment**. Set its webhook URL to `https://<your-worker>/webhooks/github` and generate a webhook secret.
2. Install the App on selected repositories in the users and organizations listed in `GITHUB_OWNERS`. Installations elsewhere are ignored.
3. [Generate a private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), convert it to PKCS#8, and set it as a secret:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem -out pi-app.pem
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < pi-app.pem
   ```

4. Find the bot ID with `curl -s 'https://api.github.com/users/<slug>%5Bbot%5D' | jq .id`, then set the remaining secrets from the table above.

Pi commits as `<slug>[bot]`. Repository tokens are scoped to one repository and are passed only to the clone and push operations that need them.

### Repository tasks and mentions

Mention `@owner/name`, optionally `@owner/name#branch`, in a prompt. Pi clones the repository only when it needs its code, checks out one `pi/<session>` branch, and shows the task and changes in the session page. A session clones at most one repository.

Ask explicitly for a commit or pull request. `create_pull_request` pushes the task branch and opens or updates a draft pull request; it refuses uncommitted changes.

Mention `@<slug>` in an issue comment to start a session with that issue. Later comments continue the same session. Mentions on a session's own pull request continue that session; other pull requests receive a 😕 reaction. Only users in `GITHUB_OWNERS` can direct Pi from GitHub, and its issue handling treats untrusted text as data rather than instructions.

### Webhook access and local testing

Cloudflare Access cannot authenticate GitHub or generic webhook senders. Add a path-specific Access application that bypasses authentication only for `webhooks/github` and `webhooks/generic`, leaving the rest of the Worker protected. The Worker verifies `GITHUB_WEBHOOK_SECRET` or `WEBHOOK_SECRET` on those paths. A correctly routed unsigned request returns `401`, not an Access redirect.

Press `t + Enter` in `npm run dev` to open a Quick Tunnel for local webhook testing. Temporarily point the App's webhook URL at `https://<random>.trycloudflare.com/webhooks/github`, then restore the production URL afterward.

## Generic webhooks

`POST /webhooks/generic` accepts Cloudflare notifications or arbitrary JSON/text, including [Workers Issues automations](https://developers.cloudflare.com/workers/observability/issues/automations/). Authenticate with `cf-webhook-auth: <WEBHOOK_SECRET>` or `Authorization: Bearer <WEBHOOK_SECRET>`.

Accepted deliveries return `202` and start a queued session. Bodies are limited to 64 KiB and treated as untrusted information. Add `?repo=owner/name`, plus optional `&branch=name`, to suggest a repository destination.

## Web tools, MCP, and skills

- **Web:** `web_fetch` reads URLs as Markdown. The browser tool uses a session's persistent Browser Run browser for interactive pages and screenshots. A dev server in the container is available to that browser at `preview.internal` only in a deployed Worker. Search uses the Exa key stored on the gateway under `WEB_SEARCH_BYOK_ALIAS`; configure it there, not in the Worker. Exa may retain search queries under its own privacy policy.
- **MCP:** add servers in **Settings**. The registry stores credentials and shares enabled tools with every session through one codemode `mcp` tool. Connect only trusted servers: tools use your credentials and results can contain prompt injection.
- **Skills:** built-ins come from `src/server/bundled-skills`, repository skills from the clone, and shared skills from `skills/` in R2. A repository skill overrides a shared skill with the same name; a built-in overrides both. Shared skills affect every session, so restrict who can write them.

Worker Previews are isolated except for external credentials: previews use separate Durable Objects and the `-preview` R2/Artifacts resources. They do not include a Computer container, and the App webhook continues to target production. Create the preview bucket with `npx wrangler r2 bucket create pi-on-cf-preview`.

## Deploy and verify

```bash
npm run check    # lint, typecheck, and both test projects
npm run build
npm run deploy
```

Deploy only from a clean clone, not an archive of the working directory. Protect the production Worker with Access, set all required secrets, configure the App webhook URL, and verify that an unsigned webhook request returns `401`.

## License

Licensed under the [MIT License](LICENSE).
