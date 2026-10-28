import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { useAgent } from 'agents/react'
import {
  PI_AGENT_PREFIX,
  PI_REGISTRY_INSTANCE,
  PI_REGISTRY_NAME,
  type PiRegistryContract,
  type PiRegistryState,
  type SessionSummary,
} from '~/contract'
import { useAgentConnection } from './use-agent-connection'
import { useRemote } from './use-remote'

type SessionRegistry = {
  agent: ReturnType<typeof useAgent<PiRegistryContract, PiRegistryState>>
  error: string
  loading: boolean
  /** Moves whenever an MCP server's connection changes, so Settings knows to reload them. */
  mcpRevision: number
  sessions: SessionSummary[]
  /** When `sessions` was listed, in milliseconds since the epoch. */
  asOf: number
}

const NO_SESSIONS: SessionSummary[] = []

const SessionRegistryContext = createContext<SessionRegistry | null>(null)

/**
 * One registry connection for the whole app. The registry bumps its state's
 * revision on every catalog change and the SDK syncs it here, so the list
 * reloads when a session is titled, opens a pull request, or moves.
 */
export function SessionRegistryProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0)
  const [mcpRevision, setMcpRevision] = useState(0)

  const useConnection = useAgentConnection()

  const agent = useConnection<PiRegistryContract, PiRegistryState>({
    agent: PI_REGISTRY_NAME,
    name: PI_REGISTRY_INSTANCE,
    prefix: PI_AGENT_PREFIX,
    onStateUpdate: (state) => setRevision(state.revision),
    // The SDK pushes the registry's MCP servers on connect and on every change.
    onMcpUpdate: () => setMcpRevision((value) => value + 1),
  })

  // Listed again at each revision; `asOf` is when, for grouping by recency.
  const list = useRemote(`sessions:${revision}`, async () => ({ sessions: await agent.stub.listSessions(), asOf: Date.now() }))
  const { value, error, loading } = list
  const sessions = value?.sessions ?? NO_SESSIONS
  const asOf = value?.asOf ?? 0

  const context = useMemo(() => ({ agent, asOf, error, loading, mcpRevision, sessions }), [agent, asOf, error, loading, mcpRevision, sessions])

  return <SessionRegistryContext.Provider value={context}>{children}</SessionRegistryContext.Provider>
}

export function useSessionRegistry(): SessionRegistry {
  const registry = useContext(SessionRegistryContext)

  if (!registry) throw new Error('useSessionRegistry needs a SessionRegistryProvider.')

  return registry
}

/** A session's name, else the title from its first prompt, else its repository. */
export function displayName(session: Pick<SessionSummary, 'id' | 'name' | 'title' | 'repo'>): string {
  return session.name?.trim() || session.title || session.repo || `Untitled ${session.id.slice(0, 8)}`
}
