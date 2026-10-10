import { env } from 'cloudflare:workers'
import type { PiRegistry, PiSession, TestBindings } from './entry'

/** The test worker's bindings, typed to the test classes. */
const bindings = env as TestBindings

/** The singleton registry, typed to the test subclass. */
export const registry = (): DurableObjectStub<PiRegistry> => bindings.PiRegistry.getByName('singleton')

/** A session Agent by its physical name, typed to the test subclass. */
export const sessionStub = (agentName: string): DurableObjectStub<PiSession> => bindings.PiSession.getByName(agentName)

/** The Agent behind a catalog entry, reached directly for test-only RPC. */
export async function session(id: string): Promise<DurableObjectStub<PiSession>> {
  const name = await registry().sessionAgentNameForTest(id)

  if (!name) throw new Error(`No session behind ${id}`)

  return sessionStub(name)
}