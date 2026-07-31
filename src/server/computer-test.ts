import { type DurableObjectStorageLike, Workspace, type WorkspaceStub } from '@cloudflare/computer'
import { WorkerBackend } from '@cloudflare/computer/backends/worker'
import { DurableObject } from 'cloudflare:workers'
import type { ComputerWorkspace } from './computer-workspace'
import { TemplateRepository } from './apps/template-repository'
import { migrateLegacyShellWorkspace } from './legacy-workspace-migration'

export class ComputerTest extends DurableObject<Env> {
  private readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [new WorkerBackend({
      id: 'shell',
      loader: this.env.APP_LOADER,
      workspace: { binding: 'ComputerTest', id: this.ctx.id.toString() },
      ctx: this.ctx,
    })],
    useThink: true,
  }) as ComputerWorkspace

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready()
    return this.workspace.stub()
  }

  async exerciseShell(): Promise<{ exitCode: number; stdout: string; stderr: string; output: string }> {
    await this.workspace.fs.writeFile('/input.txt', 'cloudflare computer\n')
    const handle = await this.workspace.shell.exec(
      "cat /input.txt | tr '[:lower:]' '[:upper:]' > /output.txt && cat /output.txt",
      { cwd: '/', encoding: 'utf8', backend: 'shell' },
    )
    const result = await handle.result()
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      output: await this.workspace.fs.readFile('/output.txt', 'utf8'),
    }
  }

  async exerciseGit(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const handle = await this.workspace.shell.exec([
      'mkdir -p /repo',
      'cd /repo',
      'git init',
      'git config user.name Computer-Test',
      'git config user.email computer-test@example.invalid',
      "printf 'hello from computer\\n' > README.md",
      'git add README.md',
      "git commit -m 'initial commit'",
      'git status --porcelain=v1',
      'git log --oneline -1',
    ].join(' && '), { cwd: '/', encoding: 'utf8', backend: 'shell' })
    const result = await handle.result()
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  async installTemplate(repository: string, commit: string): Promise<{ commit: string; fileCount: number; packageJson: string | null }> {
    const result = await new TemplateRepository(this.workspace).install({ repository, commit })
    return {
      commit: result.commit,
      fileCount: result.fileCount,
      packageJson: await this.workspace.readFile('/package.json'),
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
    const stat = await this.workspace.stat('/src/index.ts')
    return {
      migrated,
      text: await this.workspace.fs.readFile('/src/index.ts', 'utf8'),
      size: stat?.size ?? -1,
      bytes: Array.from(await this.workspace.readFileBytes('/data.bin') ?? []),
      link: await this.workspace.fs.readlink('/entry.ts'),
    }
  }
}
