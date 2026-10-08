import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAgent } from 'agents/react'
import {
  PI_AGENT_PREFIX,
  PI_REGISTRY_INSTANCE,
  PI_REGISTRY_NAME,
  type PiRegistryContract,
  type PiRegistryState,
  type SessionSummary,
} from '~/shared/pi-contract'

type SessionRegistry = {
  agent: ReturnType<typeof useAgent<PiRegistryContract, PiRegistryState>>
  error: string
  loading: boolean
  reload: () => Promise<void>
  sessions: SessionSummary[]
}

const SessionRegistryContext = createContext<SessionRegistry | null>(null)

/**
 * One registry connection for the whole app. The registry bumps its state's
 * revision on every catalog change and the SDK syncs it here, so the list
 * reloads when a session is titled, opens a pull request, or moves.
 */
export function SessionRegistryProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const reloadRef = useRef<() => Promise<void>>(async () => {})

  const agent = useAgent<PiRegistryContract, PiRegistryState>({
    agent: PI_REGISTRY_NAME,
    name: PI_REGISTRY_INSTANCE,
    prefix: PI_AGENT_PREFIX,
    onStateUpdate: () => void reloadRef.current(),
  })

  const reload = useCallback(async () => {
    const request = ++requestRef.current
    setError('')
    try {
      const next = await agent.stub.listSessions()
      if (request === requestRef.current) setSessions(next)
    } catch (caught) {
      if (request === requestRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [agent.stub])
  reloadRef.current = reload

  useEffect(() => {
    void reload()
    return () => { requestRef.current += 1 }
  }, [reload])

  const value = useMemo(() => ({ agent, error, loading, reload, sessions }), [agent, error, loading, reload, sessions])
  return <SessionRegistryContext.Provider value={value}>{children}</SessionRegistryContext.Provider>
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
