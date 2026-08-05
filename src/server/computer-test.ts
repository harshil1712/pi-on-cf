import { type DurableObjectStorageLike, Workspace, type WorkspaceStub } from '@cloudflare/computer'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { WorkerJavaScriptBackend } from '@cloudflare/computer/backends/worker-javascript'
import { createGitClient } from '@cloudflare/computer/git'
import { DurableObject } from 'cloudflare:workers'
import type { ComputerWorkspace } from './computer-workspace'
import { TemplateRepository } from './apps/template-repository'
import { migrateLegacyShellWorkspace } from './legacy-workspace-migration'
import { WORKSPACE_ROOT } from './workspace-root'

export class ComputerTest extends DurableObject<Env> {
  private readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    waitUntil: this.ctx.waitUntil.bind(this.ctx),
    backends: [
      new WorkerShellBackend({
        id: 'shell',
        loader: this.env.APP_LOADER,
        workspace: { binding: 'ComputerTest', id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
      new WorkerJavaScriptBackend({ id: 'javascript', loader: this.env.APP_LOADER, root: WORKSPACE_ROOT }),
    ],
    git: createGitClient(),
    useThink: true,
  }) as ComputerWorkspace

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready()
    return this.workspace.stub()
  }

  async exerciseShell(): Promise<{ exitCode: number; stdout: string; stderr: string; output: string }> {
    await this.workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true })
    await this.workspace.fs.writeFile(`${WORKSPACE_ROOT}/input.txt`, 'cloudflare computer\n')
    using handle = await this.workspace.runtime.exec(
      "cat input.txt | tr '[:lower:]' '[:upper:]' > output.txt && cat output.txt",
      { cwd: WORKSPACE_ROOT, encoding: 'utf8', backend: 'shell' },
    )
    const result = await handle.result()
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      output: await this.workspace.fs.readFile(`${WORKSPACE_ROOT}/output.txt`, 'utf8'),
    }
  }

  async exerciseGit(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    using handle = await this.workspace.runtime.exec([
      `mkdir -p ${WORKSPACE_ROOT}/repo`,
      `cd ${WORKSPACE_ROOT}/repo`,
      'git init',
      'git config user.name Computer-Test',
      'git config user.email computer-test@example.invalid',
      "printf 'hello from computer\\n' > README.md",
      'git add README.md',
      "git commit -m 'initial commit'",
      'git status --porcelain=v1',
      'git log --oneline -1',
    ].join(' && '), { cwd: WORKSPACE_ROOT, encoding: 'utf8', backend: 'shell' })
    const result = await handle.result()
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  async exerciseJavaScript(): Promise<{ exitCode: number; stdout: string; value: unknown; file: string }> {
    await this.workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true })
    using handle = await this.workspace.runtime.exec(`
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
      file: await this.workspace.fs.readFile(`${WORKSPACE_ROOT}/javascript.txt`, 'utf8'),
    }
  }

  async installTemplate(repository: string, commit: string): Promise<{ commit: string; fileCount: number; packageJson: string | null }> {
    const result = await new TemplateRepository(this.workspace).install({ repository, commit })
    return {
      commit: result.commit,
      fileCount: result.fileCount,
      packageJson: await this.workspace.readFile(`${WORKSPACE_ROOT}/package.json`),
    }
  }

  async migrateLegacyWorkspace(): Promise<{ migrated: number; text: string; size: number; bytes: number[]; link: string }> {
    this.ctx.storage.sql.exec(`
      CREATE TABLE cf_workspace_default (
        path TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        storage_backend TEXT NOT NULL DEFAULT 'inline',
        content_encoding TEXT NOT NULL DEFAULT 'utf8',
        content TEXT,
        target TEXT
      )
    `)
    this.ctx.storage.sql.exec(
      "INSERT INTO cf_workspace_default(path, parent_path, name, type) VALUES ('/src', '/', 'src', 'directory')",
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO cf_workspace_default(path, parent_path, name, type, content) VALUES ('/src/index.ts', '/src', 'index.ts', 'file', 'export default 42')",
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO cf_workspace_default(path, parent_path, name, type, content_encoding, content) VALUES ('/data.bin', '/', 'data.bin', 'file', 'base64', 'AP+A')",
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO cf_workspace_default(path, parent_path, name, type, target) VALUES ('/entry.ts', '/', 'entry.ts', 'symlink', '/src/index.ts')",
    )

    const migrated = await migrateLegacyShellWorkspace(
      this.ctx.storage as unknown as DurableObjectStorageLike,
      this.workspace,
    )
    const stat = await this.workspace.stat(`${WORKSPACE_ROOT}/src/index.ts`)
    return {
      migrated,
      text: await this.workspace.fs.readFile(`${WORKSPACE_ROOT}/src/index.ts`, 'utf8'),
      size: stat?.size ?? -1,
      bytes: Array.from(await this.workspace.readFileBytes(`${WORKSPACE_ROOT}/data.bin`) ?? []),
      link: await this.workspace.fs.readlink(`${WORKSPACE_ROOT}/entry.ts`),
    }
  }
}
