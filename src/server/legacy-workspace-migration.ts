import type { DurableObjectStorageLike } from '@cloudflare/computer'
import type { ComputerWorkspace } from './computer-workspace'
import { workspacePath } from './workspace-root'

type LegacyWorkspaceRow = {
  path: string
  type: 'file' | 'directory' | 'symlink'
  storage_backend: 'inline' | 'r2'
  content_encoding: 'utf8' | 'base64'
  content: string | null
  target: string | null
}

export async function migrateLegacyShellWorkspace(
  storage: DurableObjectStorageLike,
  workspace: ComputerWorkspace,
): Promise<number> {
  const legacyTable = storage.sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_workspace_default'",
  ).toArray()[0]
  if (!legacyTable) return 0

  const rows = storage.sql.exec<LegacyWorkspaceRow>(`
    SELECT path, type, storage_backend, content_encoding, content, target
    FROM cf_workspace_default
    WHERE path <> '/'
    ORDER BY length(path), path
  `).toArray()
  if (rows.length === 0) return 0

  await workspace.ready()
  for (const row of rows.filter((entry) => entry.type === 'directory')) {
    await workspace.fs.mkdir(workspacePath(row.path), { recursive: true })
  }
  for (const row of rows.filter((entry) => entry.type === 'file')) {
    if (row.storage_backend !== 'inline') {
      throw new Error(`Cannot migrate legacy R2 workspace file: ${row.path}`)
    }
    const content = row.content ?? ''
    await workspace.fs.writeFile(workspacePath(row.path), row.content_encoding === 'base64' ? decodeBase64(content) : content)
  }
  for (const row of rows.filter((entry) => entry.type === 'symlink')) {
    if (!row.target) throw new Error(`Legacy workspace symlink has no target: ${row.path}`)
    await workspace.fs.rm(workspacePath(row.path), { force: true })
    await workspace.fs.symlink(workspacePath(row.target), workspacePath(row.path))
  }
  return rows.length
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
