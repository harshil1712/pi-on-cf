import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import type { PiRegistry, PiSession, TestBindings } from './entry'

/** The test worker's bindings, typed to the test classes. */
const bindings = env as TestBindings

/** The singleton registry, typed to the test subclass. */
export const registry = (): DurableObjectStub<PiRegistry> => bindings.PiRegistry.getByName('singleton')

/** A session Agent by its physical name, typed to the test subclass. */
export const sessionStub = (agentName: string): DurableObjectStub<PiSession> => bindings.PiSession.getByName(agentName)

/**
 * Wait for the session a webhook delivery starts in the background: listed,
 * done with its prompt, and idle in the catalog. A test that stops at the
 * listing leaves the registry and the session working after the file ends,
 * and the pool's teardown then reports an unhandled error.
 */
export async function settledSession(title: string): Promise<string> {
  let id: string | undefined
  await expect.poll(async () => (id = (await registry().listSessions()).find((entry) => entry.title === title)?.id), { timeout: 10_000 }).toBeDefined()
  await expect.poll(async () => (await session(id!)).settledForTest(), { timeout: 20_000 }).toBe(true)
  await expect.poll(async () => (await registry().getSession(id!))?.status, { timeout: 10_000 }).toBe('idle')

  return id!
}

/** The Agent behind a catalog entry, reached directly for test-only RPC. */
export async function session(id: string): Promise<DurableObjectStub<PiSession>> {
  const name = await registry().sessionAgentNameForTest(id)

  if (!name) throw new Error(`No session behind ${id}`)

  return sessionStub(name)
}