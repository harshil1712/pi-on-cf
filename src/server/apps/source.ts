import type { WorkspaceFsLike } from '@cloudflare/shell'
import type { SourceFile, SourceSnapshot } from './types'

export const MAX_SOURCE_FILES = 1_000
export const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', '.wrangler'])
const encoder = new TextEncoder()

export type SourceSnapshotOptions = {
  root?: string
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export async function createSourceSnapshot(
  workspace: WorkspaceFsLike,
  options: SourceSnapshotOptions = {},
): Promise<SourceSnapshot> {
  const root = normalizeAbsolutePath(options.root ?? '/')
  const maxFiles = options.maxFiles ?? MAX_SOURCE_FILES
  const maxFileBytes = options.maxFileBytes ?? MAX_SOURCE_FILE_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? MAX_SOURCE_BYTES
  const files: SourceFile[] = []
  let totalBytes = 0

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (let offset = 0; ; offset += 200) {
      const entries = await workspace.readDir(directory, { limit: 200, offset })
      for (const entry of entries) {
        if (entry.type === 'directory' && EXCLUDED_DIRECTORIES.has(entry.name)) continue

        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          await visit(entry.path, relativePath)
          continue
        }
        if (entry.type !== 'file') continue
        if (files.length >= maxFiles) throw new Error(`Source exceeds the ${maxFiles} file limit.`)
        if (entry.size > maxFileBytes) throw new Error(`Source file exceeds the ${maxFileBytes} byte limit: ${relativePath}`)

        const bytes = await workspace.readFileBytes(entry.path)
        if (bytes === null) throw new Error(`Source file disappeared while reading: ${relativePath}`)
        if (bytes.byteLength > maxFileBytes) {
          throw new Error(`Source file exceeds the ${maxFileBytes} byte limit: ${relativePath}`)
        }
        totalBytes += bytes.byteLength
        if (totalBytes > maxTotalBytes) throw new Error(`Source exceeds the ${maxTotalBytes} byte limit.`)
        files.push({ path: relativePath, bytes })
      }
      if (entries.length < 200) break
    }
  }

  await visit(root, '')
  files.sort(comparePaths)
  return { files, totalBytes, hash: await hashSourceFiles(files) }
}

export async function hashSourceFiles(files: readonly SourceFile[]): Promise<string> {
  const ordered = [...files].sort(comparePaths)
  const parts = ordered.map((file) => {
    const path = encoder.encode(file.path)
    const part = new Uint8Array(8 + path.byteLength + file.bytes.byteLength)
    const view = new DataView(part.buffer)
    view.setUint32(0, path.byteLength)
    part.set(path, 4)
    view.setUint32(4 + path.byteLength, file.bytes.byteLength)
    part.set(file.bytes, 8 + path.byteLength)
    return part
  })
  const input = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    input.set(part, offset)
    offset += part.byteLength
  }
  const digest = await crypto.subtle.digest('SHA-256', input.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

function comparePaths(left: SourceFile, right: SourceFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}
