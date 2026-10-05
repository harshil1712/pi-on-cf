import { type DurableObjectStorageLike, getWorkspace, withWorkspace, type WorkspaceOptions } from '@cloudflare/computer'
import { WorkerJavaScriptBackend } from '@cloudflare/computer/backends/worker-javascript'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { createGitClient } from '@cloudflare/computer/git'
import { DurableObject } from 'cloudflare:workers'
import { createWorkspaceTools } from './workspace-tools'
import { WORKSPACE_ROOT } from './workspace-root'

type ToolOutcome = { isError: boolean; text: string }

class ComputerTestHost extends DurableObject<Env> {}

function workspaceOptions(self: ComputerTestHost): WorkspaceOptions {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env }
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: 'shell',
        loader: env.LOADER,
        workspace: { binding: 'ComputerTest', id: ctx.id.toString() },
        ctx,
      }),
      new WorkerJavaScriptBackend({ id: 'javascript', loader: env.LOADER, root: WORKSPACE_ROOT }),
    ],
    git: createGitClient(),
  }
}

/** A Durable Object with the same Computer backends as PiSession, minus the container. */
export class ComputerTest extends withWorkspace(ComputerTestHost, workspaceOptions) {
  async exerciseShell(): Promise<{ exitCode: number; stdout: string; stderr: string; output: string }> {
    const workspace = await getWorkspace(this)
    await workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true })
    await workspace.fs.writeFile(`${WORKSPACE_ROOT}/input.txt`, 'cloudflare computer\n')
    using handle = await workspace.runtime.exec(
      "cat input.txt | tr '[:lower:]' '[:upper:]' > output.txt && cat output.txt",
      { cwd: WORKSPACE_ROOT, encoding: 'utf8', backend: 'shell' },
    )
    const result = await handle.result()
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      output: await workspace.fs.readFile(`${WORKSPACE_ROOT}/output.txt`, 'utf8'),
    }
  }

  async exerciseGit(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const workspace = await getWorkspace(this)
    using handle = await workspace.runtime.exec([
      `mkdir -p ${WORKSPACE_ROOT}/repo`,
      `cd ${WORKSPACE_ROOT}/repo`,
      'git init',
      'git config user.name Computer-Test',
      'git config user.email computer-test@example.invalid',
      "printf 'hello from computer\\n' > README.md",
      'git add README.md',
      "git commit -m 'initial commit'",
      'git log --oneline -1',
    ].join(' && '), { cwd: WORKSPACE_ROOT, encoding: 'utf8', backend: 'shell' })
    const result = await handle.result()
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  async exerciseJavaScript(): Promise<{ exitCode: number; stdout: string; value: unknown; file: string }> {
    const workspace = await getWorkspace(this)
    await workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true })
    using handle = await workspace.runtime.exec(`
      import { writeFile } from 'node:fs/promises'
      export default async function (input) {
        const value = input.number * 2
        await writeFile('${WORKSPACE_ROOT}/javascript.txt', String(value))
        console.log('computed', value)
        return { value }
      }
    `, { backend: 'javascript', encoding: 'utf8', input: { number: 21 } })
    const result = await handle.result()
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      value: result.value,
      file: await workspace.fs.readFile(`${WORKSPACE_ROOT}/javascript.txt`, 'utf8'),
    }
  }

  /** Runs Computer's tools through the pi-durable registrations PiSession installs. */
  async exerciseTools(): Promise<{ names: string[]; replay: Record<string, string>; read: ToolOutcome; exec: ToolOutcome }> {
    const tools = createWorkspaceTools({
      workspace: await getWorkspace(this),
      shell: { defaultBackend: 'shell', backends: { shell: { description: 'Worker shell' } } },
    })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const call = async (name: string, args: unknown): Promise<ToolOutcome> => {
      const result = await byName.get(name)!.execute(
        args as never,
        { callId: `call-${name}` } as never,
        { abortSignal: new AbortController().signal } as never,
      )
      const text = (result.content ?? []).map((part) => part.type === 'text' ? part.text : '').join('')
      return { isError: result.isError === true, text }
    }
    await call('write', { path: `${WORKSPACE_ROOT}/notes.txt`, content: 'hello pi\n' })
    return {
      names: tools.map((tool) => tool.name).sort(),
      replay: Object.fromEntries(tools.map((tool) => [tool.name, tool.replay ?? 'unsafe'])),
      read: await call('read', { path: `${WORKSPACE_ROOT}/notes.txt` }),
      exec: await call('exec', { command: 'wc -l notes.txt', cwd: WORKSPACE_ROOT }),
    }
  }
}
