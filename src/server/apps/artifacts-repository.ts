import { Workspace, WorkspaceFileSystem } from '@cloudflare/shell'
import { createGit } from '@cloudflare/shell/git'
import type { AppSourceSnapshot } from './types'

export class AppArtifactsRepository {
  private readonly filesystem: WorkspaceFileSystem
  private readonly remote: string

  constructor(
    private readonly artifacts: Artifacts,
    private readonly repositoryName: string,
    namespace: string,
    accountId: string,
    private readonly workspace: Workspace,
    private readonly templateUrl: string,
    private readonly templateCommit: string,
  ) {
    this.filesystem = new WorkspaceFileSystem(workspace)
    this.remote = `https://${accountId}.artifacts.cloudflare.net/git/${encodeURIComponent(namespace)}/${encodeURIComponent(repositoryName)}.git`
  }

  async publish(source: AppSourceSnapshot): Promise<string> {
    const paths = new Set<string>()
    for (const file of source.files) {
      validatePath(file.path)
      if (paths.has(file.path)) throw new Error(`Duplicate source path: ${file.path}`)
      paths.add(file.path)
    }

    const repository = await this.getOrCreateRepository()
    const token = (await repository.repo.createToken('write', 300)).plaintext
    if (typeof token !== 'string') throw new Error('Artifacts returned an invalid repository token.')
    const password = token
    const repositoryDir = `/app-artifacts-${crypto.randomUUID()}`
    const git = createGit(this.filesystem, repositoryDir)

    try {
      await this.workspace.mkdir(repositoryDir, { recursive: true })
      if (!repository.created) {
        try {
          await git.clone({
            url: this.remote,
            dir: repositoryDir,
            branch: 'main',
            depth: 1,
            singleBranch: true,
            username: 'x',
            password,
          })
        } catch (error) {
          if (!isEmptyRepositoryError(error)) throw error
          await this.initializeFromTemplate(git, repositoryDir)
        }
      } else {
        await this.initializeFromTemplate(git, repositoryDir)
      }

      const entries = []
      for (let offset = 0; ; offset += 200) {
        const page = await this.workspace.readDir(repositoryDir, { limit: 200, offset })
        entries.push(...page)
        if (page.length < 200) break
      }
      for (const entry of entries) {
        if (entry.name !== '.git') await this.workspace.rm(entry.path, { recursive: true, force: true })
      }
      for (const file of source.files) {
        const target = `${repositoryDir}/${file.path}`
        await this.workspace.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
        await this.workspace.writeFileBytes(target, file.bytes)
      }

      for (const status of await git.status({ dir: repositoryDir })) {
        if (status.head === 1 && status.workdir === 0) await git.rm({ dir: repositoryDir, filepath: status.filepath })
      }
      await git.add({ dir: repositoryDir, filepath: '.' })
      const changes = await git.status({ dir: repositoryDir })
      if (changes.every(({ head, stage }) => head === stage)) {
        const current = (await git.log({ dir: repositoryDir, depth: 1 }))[0]
        if (!current) throw new Error('The app repository has no current revision.')
        return current.oid
      }

      const commit = await git.commit({
        dir: repositoryDir,
        message: `Publish source snapshot\n\nSource-Hash: ${source.hash}`,
        author: { name: 'Pi', email: 'pi@cloudflare.invalid' },
      })
      const pushed = await git.push({
        dir: repositoryDir,
        remote: 'origin',
        ref: 'main',
        username: 'x',
        password,
      })
      if (!pushed.ok) throw new Error('Artifacts rejected the app push because the repository changed. Retry the publish.')
      return commit.oid
    } finally {
      await Promise.all([
        this.workspace.rm(repositoryDir, { recursive: true, force: true }),
        repository.repo.revokeToken(token).catch((error) => console.warn('Could not revoke Artifacts token', error)),
      ])
    }
  }

  private async initializeFromTemplate(git: ReturnType<typeof createGit>, repositoryDir: string): Promise<void> {
    validateTemplate(this.templateUrl, this.templateCommit)
    await this.workspace.rm(repositoryDir, { recursive: true, force: true })
    await this.workspace.mkdir(repositoryDir, { recursive: true })
    await git.clone({ url: this.templateUrl, dir: repositoryDir, noCheckout: true })
    await git.checkout({ dir: repositoryDir, ref: this.templateCommit, force: true })
    const current = (await git.log({ dir: repositoryDir, ref: 'HEAD', depth: 1 }))[0]
    if (!current || current.oid.toLowerCase() !== this.templateCommit.toLowerCase()) {
      throw new Error(`Template checkout did not resolve to pinned commit ${this.templateCommit}.`)
    }
    const branches = await git.branch({ dir: repositoryDir, list: true })
    const branchNames = 'branches' in branches ? branches.branches : undefined
    if (branchNames?.includes('main')) {
      await git.branch({ dir: repositoryDir, delete: 'main' })
    }
    await git.branch({ dir: repositoryDir, name: 'main' })
    await git.checkout({ dir: repositoryDir, ref: 'main' })
    await git.remote({ dir: repositoryDir, remove: 'origin' })
    await git.remote({ dir: repositoryDir, add: { name: 'origin', url: this.remote } })
  }

  private async getOrCreateRepository(): Promise<{ repo: ArtifactsRepo; created: boolean }> {
    try {
      return { repo: await this.artifacts.get(this.repositoryName), created: false }
    } catch (error) {
      if (!isArtifactsError(error, 'NOT_FOUND')) throw error
      try {
        await this.artifacts.create(this.repositoryName, {
          description: 'App source authored by Pi',
          setDefaultBranch: 'main',
        })
      } catch (createError) {
        if (!isArtifactsError(createError, 'ALREADY_EXISTS')) throw createError
        return { repo: await this.artifacts.get(this.repositoryName), created: false }
      }
      return { repo: await this.artifacts.get(this.repositoryName), created: true }
    }
  }
}

function validatePath(path: string): void {
  if (!path || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid source path: ${path}`)
  }
}

function validateTemplate(repository: string, commit: string): void {
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    throw new Error(`Invalid template repository URL: ${repository}`)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || segments.length !== 2) {
    throw new Error('Template repository must be a public HTTPS GitHub repository URL.')
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('Template commit must be a full 40-character SHA-1 commit ID.')
}

function isEmptyRepositoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'EmptyServerResponseError' ||
    (error.name === 'NotFoundError' && /\b(main|HEAD)\b/i.test(error.message))
}

function isArtifactsError(error: unknown, code: ArtifactsErrorCode): error is ArtifactsError {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && (error as { code?: unknown }).code === code) return true
  const errorMessage = (error as { message?: unknown }).message
  const message = error instanceof Error ? error.message : typeof errorMessage === 'string' ? errorMessage : ''
  if (code === 'NOT_FOUND') return message.includes('Repository not found:')
  if (code === 'ALREADY_EXISTS') return message.includes('Repository already exists:')
  return false
}
