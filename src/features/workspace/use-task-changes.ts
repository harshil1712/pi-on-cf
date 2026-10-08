import { useCallback, useEffect, useRef, useState } from 'react'
import type { PiSessionContract, SessionTask, TaskChange } from '~/shared/pi-contract'

type ChangesStub = Pick<PiSessionContract, 'listChanges' | 'readChange'>

/**
 * The files a task changed since its base commit, and the diff of the one
 * selected. Reloads whenever `version` moves, as the file list does.
 */
export function useTaskChanges(stub: ChangesStub, task: SessionTask | null, version: number) {
  const [changes, setChanges] = useState<TaskChange[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState('')
  const requestRef = useRef(0)
  const hasTask = Boolean(task)

  const refresh = useCallback(async () => {
    if (!hasTask) return
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const next = await stub.listChanges()
      if (request !== requestRef.current) return
      setChanges(next)
      setSelectedPath((current) => next.some((change) => change.path === current) ? current : (next[0]?.path ?? ''))
    } catch (caught) {
      if (request === requestRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [hasTask, stub])

  useEffect(() => {
    void refresh()
  }, [refresh, version])

  useEffect(() => () => { requestRef.current += 1 }, [])

  // A new list may hold new contents for the same path.
  useEffect(() => {
    setDiff('')
    setDiffError('')
    if (!selectedPath) return
    let ignore = false
    stub.readChange(selectedPath).then((next) => {
      if (!ignore) setDiff(next)
    }).catch((caught) => {
      if (!ignore) setDiffError(caught instanceof Error ? caught.message : String(caught))
    })
    return () => { ignore = true }
  }, [changes, selectedPath, stub])

  return { changes, diff, diffError, error, loading, refresh, selectedPath, setSelectedPath }
}
