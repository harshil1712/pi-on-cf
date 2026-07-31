import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ComputerTest } from './computer-test'

type ComputerTestEnv = Env & { ComputerTest: DurableObjectNamespace<ComputerTest> }

const computer = (name: string) => (env as ComputerTestEnv).ComputerTest.getByName(name)

describe('@cloudflare/computer integration', () => {
  it('runs shell pipelines against the durable workspace', async () => {
    const result = await computer('shell').exerciseShell()

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'CLOUDFLARE COMPUTER\n',
      stderr: '',
      output: 'CLOUDFLARE COMPUTER\n',
    })
  })

  it('runs the Computer Git command against the durable workspace', async () => {
    const result = await computer('git').exerciseGit()

    expect(result.exitCode, JSON.stringify(result)).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/initial commit/)
  })

  it('clones and installs the pinned public app template', async () => {
    const commit = 'f17ae99edcea0b1be4ea0a6be2f4a4694e2457a7'
    const result = await computer('template').installTemplate(
      'https://github.com/harshil1712/cf-react-template.git',
      commit,
    )

    expect(result.commit).toBe(commit)
    expect(result.fileCount).toBeGreaterThan(0)
    expect(result.packageJson).toContain('"name"')
  }, 30_000)

  it('migrates files from the legacy Shell workspace', async () => {
    await expect(computer('legacy-migration').migrateLegacyWorkspace()).resolves.toEqual({
      migrated: 4,
      text: 'export default 42',
      size: 17,
      bytes: [0, 255, 128],
      link: '/src/index.ts',
    })
  })
})
