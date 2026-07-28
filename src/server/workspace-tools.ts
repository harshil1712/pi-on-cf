import type { FileSystemStateBackend, WorkspaceFsLike } from '@cloudflare/shell'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

const text = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)),
  }],
  details: {},
})

export function createWorkspaceTools(workspace: WorkspaceFsLike, workspaceState: FileSystemStateBackend) {
  const readSchema = Type.Object({ path: Type.String({ description: 'Absolute workspace path' }) })
  const writeSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    content: Type.String({ description: 'Complete file contents' }),
  })
  const editSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    search: Type.String({ description: 'Exact text to replace' }),
    replacement: Type.String({ description: 'Replacement text' }),
  })
  const listSchema = Type.Object({
    path: Type.Optional(Type.String({ description: 'Directory path, defaults to /' })),
  })
  const findSchema = Type.Object({ pattern: Type.String({ description: 'Glob pattern, such as **/*.ts' }) })
  const grepSchema = Type.Object({
    pattern: Type.String({ description: 'File glob to search' }),
    query: Type.String({ description: 'Text or regular expression to find' }),
  })

  const readTool: AgentTool<typeof readSchema> = {
    name: 'read',
    label: 'Read file',
    description: 'Read a UTF-8 file from the durable workspace.',
    parameters: readSchema,
    execute: async (_id, { path }) => {
      const content = await workspace.readFile(path)
      if (content === null) throw new Error(`File not found: ${path}`)
      return text(content)
    },
  }
  const writeTool: AgentTool<typeof writeSchema> = {
    name: 'write',
    label: 'Write file',
    description: 'Write a complete UTF-8 file to the durable workspace.',
    parameters: writeSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, content }) => {
      await workspace.writeFile(path, content)
      return text(`Wrote ${path}`)
    },
  }
  const editTool: AgentTool<typeof editSchema> = {
    name: 'edit',
    label: 'Edit file',
    description: 'Replace exact text in a durable workspace file.',
    parameters: editSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, search, replacement }) =>
      text(await workspaceState.replaceInFile(path, search, replacement)),
  }
  const listTool: AgentTool<typeof listSchema> = {
    name: 'list',
    label: 'List directory',
    description: 'List files and directories in the durable workspace.',
    parameters: listSchema,
    execute: async (_id, { path }) => text(await workspace.readDir(path ?? '/')),
  }
  const findTool: AgentTool<typeof findSchema> = {
    name: 'find',
    label: 'Find files',
    description: 'Find durable workspace files using a glob pattern.',
    parameters: findSchema,
    execute: async (_id, { pattern }) => text(await workspaceState.glob(pattern)),
  }
  const grepTool: AgentTool<typeof grepSchema> = {
    name: 'grep',
    label: 'Search files',
    description: 'Search matching durable workspace files for text.',
    parameters: grepSchema,
    execute: async (_id, { pattern, query }) => text(await workspaceState.searchFiles(pattern, query)),
  }

  return [readTool, writeTool, editTool, listTool, findTool, grepTool]
}
