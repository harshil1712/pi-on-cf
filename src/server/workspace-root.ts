export const WORKSPACE_ROOT = '/workspace'

export function requireWorkspacePath(path: string): string {
  if (path.includes('\0') || path.split('/').includes('..') || (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`))) {
    throw new Error(`Workspace paths must be under ${WORKSPACE_ROOT}.`)
  }
  return path
}

export function workspacePath(path: string): string {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Workspace path must be absolute.')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error("Workspace path cannot contain '..'.")
    parts.push(part)
  }
  const normalized = `/${parts.join('/')}`
  if (normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)) return normalized
  return normalized === '/' ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${normalized}`
}
