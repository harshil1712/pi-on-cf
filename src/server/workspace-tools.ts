import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import type { WorkspaceRuntimeValue } from '@cloudflare/computer'
import { Type } from 'typebox'
import type { SessionSearchResult } from '../shared/pi-contract'
import type { ComputerWorkspace } from './computer-workspace'

type RegistrySearch = {
  searchSessions(input: { query: string; limit?: number }): Promise<SessionSearchResult[]>
}

const text = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)),
  }],
  details: {},
})

export function createWorkspaceTools(workspace: ComputerWorkspace) {
  const readSchema = Type.Object({ path: Type.String({ description: 'Absolute workspace path' }) })
  const writeSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    content: Type.String({ description: 'Complete file contents' }),
  })
  const editSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    search: Type.String({ minLength: 1, description: 'Non-empty exact text to replace' }),
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
  const execSchema = Type.Object({
    command: Type.String({ description: 'Shell command to run in the workspace' }),
    cwd: Type.Optional(Type.String({ description: 'Durable workspace directory. Container execution maps / to /workspace.' })),
    backend: Type.Optional(Type.Union([
      Type.Literal('shell'),
      Type.Literal('container'),
    ], { description: 'Use shell for fast text and Git operations, or container for native binaries and network access' })),
  })
  const javascriptSchema = Type.Object({
    source: Type.String({ description: 'ECMAScript module with a default export or default function' }),
    input: Type.Optional(Type.Unknown({ description: 'JSON-compatible input passed to the default function' })),
    cwd: Type.Optional(Type.String({ description: 'Module working directory, defaults to /' })),
  })
  const publishSchema = Type.Object({
    path: Type.String({ description: 'Absolute path of the workspace file to share' }),
    expiresAfterMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 604_800_000 })),
  })
  const artifactsSchema = Type.Object({
    argv: Type.Array(Type.String(), { minItems: 1, description: 'Artifacts CLI arguments, such as ["list"]' }),
  })

  const readTool: AgentHarnessTool<undefined, typeof readSchema> = {
    name: 'read',
    label: 'Read file',
    description: 'Read a UTF-8 file from the durable workspace.',
    parameters: readSchema,
    execute: async (_id, { path }, signal) => {
      signal?.throwIfAborted()
      const content = await workspace.readFile(path)
      signal?.throwIfAborted()
      if (content === null) throw new Error(`File not found: ${path}`)
      return text(content)
    },
  }
  const writeTool: AgentHarnessTool<undefined, typeof writeSchema> = {
    name: 'write',
    label: 'Write file',
    description: 'Write a complete UTF-8 file to the durable workspace.',
    parameters: writeSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, content }, signal) => {
      signal?.throwIfAborted()
      await workspace.writeFile(path, content)
      signal?.throwIfAborted()
      return text(`Wrote ${path}`)
    },
  }
  const editTool: AgentHarnessTool<undefined, typeof editSchema> = {
    name: 'edit',
    label: 'Edit file',
    description: 'Replace exact text in a durable workspace file.',
    parameters: editSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, search, replacement }, signal) => {
      signal?.throwIfAborted()
      const content = await workspace.readFile(path)
      if (content === null) throw new Error(`File not found: ${path}`)
      const occurrences = content.split(search).length - 1
      if (occurrences !== 1) throw new Error(`Expected exactly one match in ${path}, found ${occurrences}.`)
      await workspace.writeFile(path, content.replace(search, replacement))
      signal?.throwIfAborted()
      return text(`Updated ${path}`)
    },
  }
  const listTool: AgentHarnessTool<undefined, typeof listSchema> = {
    name: 'list',
    label: 'List directory',
    description: 'List files and directories in the durable workspace.',
    parameters: listSchema,
    execute: async (_id, { path }, signal) => {
      signal?.throwIfAborted()
      const result = await workspace.readDir(path ?? '/')
      signal?.throwIfAborted()
      return text(result)
    },
  }
  const findTool: AgentHarnessTool<undefined, typeof findSchema> = {
    name: 'find',
    label: 'Find files',
    description: 'Find durable workspace files using a glob pattern.',
    parameters: findSchema,
    execute: async (_id, { pattern }, signal) => {
      signal?.throwIfAborted()
      const result = await workspace.glob(pattern)
      signal?.throwIfAborted()
      return text(result)
    },
  }
  const grepTool: AgentHarnessTool<undefined, typeof grepSchema> = {
    name: 'grep',
    label: 'Search files',
    description: 'Search matching durable workspace files for text.',
    parameters: grepSchema,
    execute: async (_id, { pattern, query }, signal) => {
      signal?.throwIfAborted()
      const files = (await workspace.glob(pattern)).filter((entry) => entry.type === 'file')
      const result = (await Promise.all(files.map((file) => workspace.fs.grep(query, file.path)))).flat()
      signal?.throwIfAborted()
      return text(result)
    },
  }

  const execTool: AgentHarnessTool<undefined, typeof execSchema> = {
    name: 'exec',
    label: 'Execute command',
    description: 'Run a command with Computer. Use shell for fast built-in text tools and Git; use container for Linux, Node.js, npm, native binaries, and network access.',
    parameters: execSchema,
    executionMode: 'sequential',
    execute: async (_id, { command, cwd, backend }, signal) => {
      signal?.throwIfAborted()
      const selectedBackend = backend ?? 'shell'
      using handle = await workspace.runtime.exec(command, {
        cwd: selectedBackend === 'container' ? containerPath(cwd ?? '/') : (cwd ?? '/'),
        encoding: 'utf8',
        backend: selectedBackend,
      })
      const abort = () => void handle.kill('SIGTERM').catch(() => undefined)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await handle.result()
        signal?.throwIfAborted()
        return text({
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          pushed: result.pushed,
          pulled: result.pulled,
          skipped: result.skipped,
          sync: result.sync,
        })
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }

  const javascriptTool: AgentHarnessTool<undefined, typeof javascriptSchema> = {
    name: 'javascript',
    label: 'Run JavaScript',
    description: 'Run an ECMAScript module in Computer\'s isolated Worker JavaScript backend. Supports structured input/results, durable imports, node:fs/promises, ws:git, and ws:artifacts.',
    parameters: javascriptSchema,
    execute: async (_id, { source, input, cwd }, signal) => {
      signal?.throwIfAborted()
      using handle = await workspace.runtime.exec(source, {
        backend: 'javascript',
        cwd: cwd ?? '/',
        encoding: 'utf8',
        input: input as WorkspaceRuntimeValue | undefined,
      })
      const abort = () => void handle.kill('SIGTERM').catch(() => undefined)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await handle.result()
        signal?.throwIfAborted()
        return text({
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          value: result.value,
          pushed: result.pushed,
          pulled: result.pulled,
          skipped: result.skipped,
          sync: result.sync,
        })
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }

  const publishTool: AgentHarnessTool<undefined, typeof publishSchema> = {
    name: 'publish',
    label: 'Publish file',
    description: 'Publish a workspace file with Computer Assets and return an expiring URL.',
    parameters: publishSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, expiresAfterMs }, signal) => {
      signal?.throwIfAborted()
      if (!workspace.assets) throw new Error('Computer Assets is not configured.')
      const url = await workspace.assets.share(path, { expiresAfter: expiresAfterMs ?? 3_600_000 })
      signal?.throwIfAborted()
      return text({ path, url })
    },
  }

  const artifactsTool: AgentHarnessTool<undefined, typeof artifactsSchema> = {
    name: 'artifacts',
    label: 'Manage artifacts',
    description: 'Manage session-scoped Cloudflare Artifact repositories through Computer\'s native CLI.',
    parameters: artifactsSchema,
    executionMode: 'sequential',
    execute: async (_id, { argv }, signal) => {
      signal?.throwIfAborted()
      const result = await workspace.artifacts.cli({ argv })
      signal?.throwIfAborted()
      return text(result)
    },
  }

  return [readTool, writeTool, editTool, listTool, findTool, grepTool, execTool, javascriptTool, publishTool, artifactsTool]
}

function containerPath(path: string): string {
  if (!path.startsWith('/')) throw new Error('Container cwd must be an absolute durable workspace path.')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error("Container cwd cannot contain '..'.")
    parts.push(part)
  }
  const normalized = `/${parts.join('/')}`
  if (normalized === '/workspace' || normalized.startsWith('/workspace/')) return normalized
  return normalized === '/' ? '/workspace' : `/workspace${normalized}`
}

export function createInitializeAppTool(initialize: () => Promise<void>): AgentHarnessTool<undefined> {
  return {
    name: 'initialize_app',
    label: 'Initialize app',
    description: 'Install the pinned React and Cloudflare starter into this session. Call this only when the user asks to build an app.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    execute: async (_id, _params, signal) => {
      signal?.throwIfAborted()
      await initialize()
      signal?.throwIfAborted()
      return text('Initialized the React and Cloudflare app workspace.')
    },
  }
}

export function createSessionSearchTool(
  registry: RegistrySearch,
): AgentHarnessTool<undefined> {
  const parameters = Type.Object({
    query: Type.String({ description: 'Lexical query, quoted phrase, or re: regular expression' }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  })
  return {
    name: 'session_search',
    label: 'Search sessions',
    description: 'Search prior Pi sessions for relevant user and assistant message text.',
    parameters,
    execute: async (_id, { query, limit }, signal) => {
      signal?.throwIfAborted()
      const results = await registry.searchSessions({ query, limit })
      signal?.throwIfAborted()
      return text(results.map(({ session, matches }) => ({
        sessionId: session.id,
        name: session.name,
        updatedAt: session.updatedAt,
        matches: matches.map(({ entryId, role, timestamp, text: matchText }) => ({
          entryId,
          role,
          timestamp,
          text: matchText.slice(0, 2_000),
        })),
      })))
    },
  }
}
