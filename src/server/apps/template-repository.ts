import { WorkspaceFileSystem, type WorkspaceFsLike } from '@cloudflare/shell'
import { createGit } from '@cloudflare/shell/git'
import type { TemplateSourceSummary } from './types'

export type TemplateSource = {
  repository: string
  commit: string
}

export class TemplateRepository {
  private readonly filesystem: WorkspaceFileSystem

  constructor(private readonly workspace: WorkspaceFsLike) {
    this.filesystem = new WorkspaceFileSystem(workspace)
  }

  async install(source: TemplateSource, destination = '/'): Promise<TemplateSourceSummary> {
    validateRepository(source.repository)
    if (!/^[0-9a-f]{40}$/i.test(source.commit)) {
      throw new Error('Template commit must be a full 40-character SHA-1 commit ID.')
    }

    const target = normalizeAbsolutePath(destination)
    const temporaryDirectory = `/.template-repository-${crypto.randomUUID()}`
    await this.workspace.mkdir(temporaryDirectory, { recursive: true })
    const git = createGit(this.filesystem, temporaryDirectory)

    try {
      await git.clone({
        url: source.repository,
        dir: temporaryDirectory,
        noCheckout: true,
      })
      await git.checkout({ dir: temporaryDirectory, ref: source.commit, force: true })
      const current = (await git.log({ dir: temporaryDirectory, ref: 'HEAD', depth: 1 }))[0]
      if (!current || current.oid.toLowerCase() !== source.commit.toLowerCase()) {
        throw new Error(`Template checkout did not resolve to pinned commit ${source.commit}.`)
      }

      let fileCount = 0
      let totalBytes = 0
      await this.workspace.mkdir(target, { recursive: true })

      const copyDirectory = async (directory: string, relativeDirectory: string): Promise<void> => {
        for (let offset = 0; ; offset += 200) {
          const entries = await this.workspace.readDir(directory, { limit: 200, offset })
          for (const entry of entries) {
            if (relativeDirectory === '' && entry.name === '.git') continue
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            const destinationPath = joinAbsolute(target, relativePath)
            if (entry.type === 'directory') {
              await this.workspace.mkdir(destinationPath, { recursive: true })
              await copyDirectory(entry.path, relativePath)
              continue
            }
            if (entry.type !== 'file') continue

            const bytes = await this.workspace.readFileBytes(entry.path)
            if (bytes === null) throw new Error(`Template file disappeared while copying: ${relativePath}`)
            await this.workspace.mkdir(parentPath(destinationPath), { recursive: true })
            await this.workspace.writeFileBytes(destinationPath, bytes)
            fileCount += 1
            totalBytes += bytes.byteLength
          }
          if (entries.length < 200) break
        }
      }

      await copyDirectory(temporaryDirectory, '')
      return {
        repository: source.repository,
        commit: current.oid,
        fileCount,
        totalBytes,
      }
    } finally {
      await this.workspace.rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

function validateRepository(repository: string): void {
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    throw new Error(`Invalid template repository URL: ${repository}`)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    segments.length !== 2 ||
    !segments[0] ||
    !segments[1]?.replace(/\.git$/, '')
  ) {
    throw new Error('Template repository must be a public HTTPS GitHub repository URL.')
  }
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith('/')) throw new Error(`Workspace path must be absolute: ${path}`)
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error(`Workspace path cannot contain '..': ${path}`)
    parts.push(part)
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

function joinAbsolute(root: string, relativePath: string): string {
  return root === '/' ? `/${relativePath}` : `${root}/${relativePath}`
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
