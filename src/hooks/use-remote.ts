import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { errorMessage } from '~/lib/error-message'

/** What `useRemote` loaded last, and the request it answers. */
type Loaded<T> = { request: string; value: T | undefined; error: string }

export type Remote<T> = {
  /** The value loaded last, possibly for an earlier key, so a list stays on screen while it reloads. */
  value: T | undefined
  /** The value for the current key only, so a preview never shows another file's contents. */
  current: T | undefined
  /** Why the current request failed, or ''. */
  error: string
  /** Whether the current request is still on its way. */
  loading: boolean
  /** Load the current key again. */
  reload: () => void
  /** Which request `value` answers; it moves with every answer, a reload of the same key included. */
  answered: string | null
}

/**
 * Load `load()` whenever `key` changes, and on `reload()`; a null key loads
 * nothing. Answers to an older request are dropped, and loading is derived
 * from which request was answered last, so no state is set while rendering
 * or synchronously in an effect. `load` always runs as last rendered, so it
 * need not be memoized: change `key` to load something else.
 */
export function useRemote<T>(key: string | null, load: () => Promise<T>): Remote<T> {
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const request = key === null ? null : `${nonce}:${key}`
  const run = useEffectEvent(load)

  useEffect(() => {
    if (request === null) return
    let ignore = false
    // Settles however `load` ends, a synchronous throw included.
    new Promise<T>((resolve) => resolve(run())).then((value) => {
      if (!ignore) setLoaded({ request, value, error: '' })
    }, (cause: unknown) => {
      if (!ignore) setLoaded((last) => ({ request, value: last?.value, error: errorMessage(cause) }))
    })

    return () => { ignore = true }
  }, [request])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  const answered = loaded !== null && loaded.request === request

  return {
    value: loaded?.value,
    current: answered && !loaded.error ? loaded.value : undefined,
    error: answered ? loaded.error : '',
    loading: request !== null && !answered,
    reload,
    answered: loaded?.request ?? null,
  }
}
