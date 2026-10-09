import { createAppAuth } from '@octokit/auth-app'
import type { Repository } from '~/contract'
import { appInstallations, type Installation, installationOwner, installationRepositories, type RepoRef, repoInstallation, repoSlug } from './github'

/** What reaching GitHub as the App takes from the environment. */
export type GitHubAppConfig = Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_OWNERS'>

/**
 * One auth per App and key in each isolate, so `@octokit/auth-app` caches
 * installation tokens across calls until shortly before they expire.
 */
const auths = new Map<string, ReturnType<typeof createAppAuth>>()

function appAuth(config: GitHubAppConfig) {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY || !config.GITHUB_OWNERS) {
    throw new Error('Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_OWNERS to work on GitHub repositories.')
  }
  const key = `${config.GITHUB_APP_ID}:${config.GITHUB_APP_PRIVATE_KEY}`
  let auth = auths.get(key)
  if (!auth) {
    auth = createAppAuth({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY })
    auths.set(key, auth)
  }
  return auth
}

/**
 * Whether an installation is on one of the accounts in `GITHUB_OWNERS`.
 * The App must be public to install on more than one account, so anyone
 * can install it; their installations are ignored.
 */
function owned(config: GitHubAppConfig, installation: Installation): boolean {
  const owners = config.GITHUB_OWNERS.split(',').map((owner) => owner.trim().toLowerCase())
  return owners.includes(installationOwner(installation).toLowerCase())
}

/**
 * An installation token that can reach `repo` and nothing else, to clone,
 * push and open pull requests there. Lasts an hour.
 */
export async function repoToken(config: GitHubAppConfig, repo: RepoRef): Promise<string> {
  const auth = appAuth(config)
  const installation = await repoInstallation((await auth({ type: 'app' })).token, repo)
  if (!installation || !owned(config, installation)) {
    throw new Error(`The GitHub App is not installed on ${repoSlug(repo)}. Install it there, on an account in GITHUB_OWNERS, to work on it.`)
  }
  const { token } = await auth({ type: 'installation', installationId: installation.id, repositoryNames: [repo.name] })
  return token
}

/** The repositories of every owned installation, most recently pushed first. */
export async function listRepositories(config: GitHubAppConfig): Promise<Repository[]> {
  const auth = appAuth(config)
  const installations = (await appInstallations((await auth({ type: 'app' })).token)).filter((installation) => owned(config, installation))
  const lists = await Promise.all(installations.map(async (installation) => {
    const { token } = await auth({ type: 'installation', installationId: installation.id })
    return installationRepositories(token)
  }))
  return lists.flat()
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    .map(({ pushedAt: _pushedAt, ...repo }) => repo)
}

/**
 * Who Pi commits as: the App's bot user, which GitHub links to the App.
 * The bot's user ID is in `https://api.github.com/users/<slug>%5Bbot%5D`.
 */
export function botIdentity(env: Pick<Env, 'GITHUB_APP_SLUG' | 'GITHUB_APP_BOT_ID'>): { name: string; email: string } {
  const name = `${env.GITHUB_APP_SLUG}[bot]`
  return { name, email: `${env.GITHUB_APP_BOT_ID}+${name}@users.noreply.github.com` }
}
