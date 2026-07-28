import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgent } from 'agents/react'
import {
  PI_AGENT_PREFIX,
  PI_REGISTRY_INSTANCE,
  PI_REGISTRY_NAME,
  type PiRegistryContract,
  type SessionSearchResult,
  type SessionSummary,
} from '../../shared/pi-contract'

export function useSessionRegistry() {
  const agent = useAgent<PiRegistryContract, unknown>({
    agent: PI_REGISTRY_NAME,
    name: PI_REGISTRY_INSTANCE,
    prefix: PI_AGENT_PREFIX,
  })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [results, setResults] = useState<SessionSearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const reload = useCallback(async (query = '') => {
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const [nextSessions, nextResults] = await Promise.all([
        agent.stub.listSessions({ query: query.trim() || undefined, limit: 100, sort: query.trim() ? 'relevance' : 'recent' }),
        query.trim() ? agent.stub.searchSessions({ query: query.trim(), limit: 30, sort: 'relevance' }) : Promise.resolve([]),
      ])
      if (request !== requestRef.current) return
      setSessions(nextSessions)
      setResults(nextResults)
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

  return { agent, error, loading, reload, results, sessions }
}
