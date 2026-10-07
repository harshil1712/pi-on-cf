import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgent } from 'agents/react'
import {
  PI_AGENT_PREFIX,
  PI_REGISTRY_INSTANCE,
  PI_REGISTRY_NAME,
  type PiRegistryContract,
  type SessionSummary,
} from '~/shared/pi-contract'

export function useSessionRegistry() {
  const agent = useAgent<PiRegistryContract, unknown>({
    agent: PI_REGISTRY_NAME,
    name: PI_REGISTRY_INSTANCE,
    prefix: PI_AGENT_PREFIX,
  })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const reload = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const nextSessions = await agent.stub.listSessions()
      if (request === requestRef.current) setSessions(nextSessions)
    } catch (caught) {
      if (request === requestRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [agent.stub])

  useEffect(() => {
    void reload()
    return () => { requestRef.current += 1 }
  }, [reload])

  return { agent, error, loading, reload, sessions }
}
