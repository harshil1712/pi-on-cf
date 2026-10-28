import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRemote } from '~/hooks/use-remote'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}

  let reject: (cause: Error) => void = () => {}

  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })

  return { promise, resolve, reject }
}

describe('useRemote', () => {
  it('loads for its key, and is loading until the answer comes', async () => {
    const { result } = renderHook(() => useRemote('a', async () => 'value a'))
    expect(result.current.loading).toBe(true)
    expect(result.current.current).toBeUndefined()

    await waitFor(() => expect(result.current.current).toBe('value a'))
    expect(result.current.loading).toBe(false)
    expect(result.current.value).toBe('value a')
  })

  it('loads nothing for a null key', () => {
    let calls = 0

    const { result } = renderHook(() => useRemote(null, async () => {
      calls += 1

      return 'never'
    }))

    expect(result.current.loading).toBe(false)
    expect(calls).toBe(0)
  })

  it('keeps the last value while a new key loads, but not as the current one', async () => {
    const answers = new Map([['a', deferred<string>()], ['b', deferred<string>()]])
    const { result, rerender } = renderHook(({ key }) => useRemote(key, () => answers.get(key)!.promise), { initialProps: { key: 'a' } })
    await act(async () => answers.get('a')!.resolve('value a'))

    rerender({ key: 'b' })
    expect(result.current.value).toBe('value a')
    expect(result.current.current).toBeUndefined()
    expect(result.current.loading).toBe(true)

    await act(async () => answers.get('b')!.resolve('value b'))
    expect(result.current.current).toBe('value b')
  })

  it('drops an answer to a key it has moved on from', async () => {
    const answers = new Map([['a', deferred<string>()], ['b', deferred<string>()]])
    const { result, rerender } = renderHook(({ key }) => useRemote(key, () => answers.get(key)!.promise), { initialProps: { key: 'a' } })

    rerender({ key: 'b' })
    await act(async () => answers.get('b')!.resolve('value b'))
    await act(async () => answers.get('a')!.resolve('late a'))

    expect(result.current.current).toBe('value b')
  })

  it('loads the same key again on reload, and says which request it answers', async () => {
    let calls = 0

    const { result } = renderHook(() => useRemote('a', async () => {
      calls += 1

      return `value ${calls}`
    }))

    await waitFor(() => expect(result.current.current).toBe('value 1'))
    const first = result.current.answered

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.current).toBe('value 2'))
    expect(result.current.answered).not.toBe(first)
  })

  it('reports a failure, keeping the last value but not as current', async () => {
    const answers = new Map([['a', deferred<string>()], ['b', deferred<string>()]])
    const { result, rerender } = renderHook(({ key }) => useRemote(key, () => answers.get(key)!.promise), { initialProps: { key: 'a' } })
    await act(async () => answers.get('a')!.resolve('value a'))

    rerender({ key: 'b' })
    await act(async () => answers.get('b')!.reject(new Error('gone')))

    expect(result.current.error).toBe('gone')
    expect(result.current.value).toBe('value a')
    expect(result.current.current).toBeUndefined()
    expect(result.current.loading).toBe(false)
  })

  it('reports a load that throws before returning a promise', async () => {
    const { result } = renderHook(() => useRemote('a', (): Promise<string> => {
      throw new Error('no stub')
    }))

    await waitFor(() => expect(result.current.error).toBe('no stub'))
  })
})
