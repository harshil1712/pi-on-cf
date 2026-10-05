import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ComputerTest } from './computer-test'

type ComputerTestEnv = Env & { ComputerTest: DurableObjectNamespace<ComputerTest> }

const computer = (name: string) => (env as ComputerTestEnv).ComputerTest.getByName(name)

describe('@cloudflare/computer integration', () => {
  it('runs shell pipelines against the durable workspace', async () => {
    await expect(computer('shell').exerciseShell()).resolves.toEqual({
      exitCode: 0,
      stdout: 'CLOUDFLARE COMPUTER\n',
      stderr: '',
      output: 'CLOUDFLARE COMPUTER\n',
    })
  })

  it('runs git in the Worker shell', async () => {
    const result = await computer('git').exerciseGit()

    expect(result.exitCode, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toMatch(/initial commit/)
  })

  it('runs structured modules in the Worker JavaScript backend', async () => {
    await expect(computer('javascript').exerciseJavaScript()).resolves.toEqual({
      exitCode: 0,
      stdout: 'computed 42\n',
      value: { value: 42 },
      file: '42',
    })
  })

  it('exposes Computer tools as pi-durable registrations', async () => {
    const result = await computer('tools').exerciseTools()

    expect(result.names).toEqual(['delete', 'edit', 'exec', 'find', 'grep', 'ls', 'read', 'write'])
    expect(result.replay).toMatchObject({ read: 'safe', write: 'safe', edit: 'unsafe', exec: 'unsafe' })
    expect(result.read).toMatchObject({ isError: false, text: expect.stringContaining('hello pi') })
    expect(result.exec).toMatchObject({ isError: false, text: expect.stringMatching(/\b1\b/) })
  })
})
