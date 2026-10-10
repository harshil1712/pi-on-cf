import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserTabView } from '~/contract'

export type BrowserView = {
  /** Whether the deployment runs a browser at all; the view only exists when it does. */
  available: boolean
  tabs: BrowserTabView[]
  /** The tab on screen, with the Live View URL its frame connected with. */
  selected: BrowserTabView | null
  loading: boolean
  error: string
  /**
   * List the tabs again. The tab on screen keeps its connection unless
   * `reconnect` asks for a fresh one (its URL only connects for about five
   * minutes), and a tab Pi opened since the last listing takes over.
   */
  refresh: (options?: { reconnect?: boolean }) => Promise<void>
  select: (targetId: string) => Promise<void>
}

/**
 * Pi's browser tabs for the session page's Browser view. `browserRuns`
 * counts finished browser tool calls: while the view is `active`, each new
 * one lists the tabs again, so the view follows the tab Pi opens.
 */
export function useBrowserView(
  liveView: () => Promise<BrowserTabView[] | null>,
  { isReady, active, browserRuns }: { isReady: boolean; active: boolean; browserRuns: number },
): BrowserView {
  const [available, setAvailable] = useState(false)
  const [tabs, setTabs] = useState<BrowserTabView[]>([])
  const [selected, setSelected] = useState<BrowserTabView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const current = useRef<BrowserTabView | null>(null)
  const known = useRef<Set<string> | null>(null)

  const load = useCallback(async ({ reconnect = false, targetId }: { reconnect?: boolean; targetId?: string } = {}) => {
    setLoading(true)
    try {
      const listed = await liveView()
      setError('')
      if (!listed) {
        setAvailable(false)
        return
      }
      setAvailable(true)
      setTabs(listed)
      const previous = known.current
      known.current = new Set(listed.map((tab) => tab.targetId))
      const opened = previous && listed.find((tab) => !previous.has(tab.targetId))
      const kept = current.current && listed.find((tab) => tab.targetId === current.current?.targetId)
      const next = (targetId && listed.find((tab) => tab.targetId === targetId))
        || opened
        || (kept && (reconnect ? kept : current.current))
        || listed[0]
        || null
      current.current = next
      setSelected(next)
    } catch {
      setError('Could not reach Pi’s browser. Try again in a moment.')
    } finally {
      setLoading(false)
    }
  }, [liveView])

  // The probe: whether there is a browser, and its tabs so far.
  useEffect(() => {
    if (isReady) void load()
  }, [isReady, load])

  // A new browser run lists again; opening the view doesn't, since its `refresh` does.
  const activeNow = useRef(active)
  activeNow.current = active
  useEffect(() => {
    if (activeNow.current && browserRuns > 0) void load()
  }, [browserRuns, load])

  const refresh = useCallback((options?: { reconnect?: boolean }) => load(options), [load])
  const select = useCallback((targetId: string) => load({ targetId }), [load])
  return { available, tabs, selected, loading, error, refresh, select }
}
