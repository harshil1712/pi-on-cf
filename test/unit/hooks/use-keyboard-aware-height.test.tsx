import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useKeyboardAwareHeight } from '~/hooks/use-keyboard-aware-height'

/** A stand-in for the parts of window.visualViewport the hook reads and listens to. */
function stubVisualViewport(height: number, offsetTop = 0) {
  const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number }
  viewport.height = height
  viewport.offsetTop = offsetTop
  Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: viewport })
  return viewport
}

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height')

/** The hook settles its writes inside an animation frame (16ms, in the test setup), so wait past one. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
}

function Probe() {
  useKeyboardAwareHeight()
  return null
}

afterEach(() => {
  cleanup()
  // jsdom has no visual viewport of its own; a test's stub must not leak into the next one.
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  document.documentElement.style.removeProperty('--app-height')
})

describe('useKeyboardAwareHeight', () => {
  it('pins the app height to the visible viewport while a keyboard covers the screen', async () => {
    // Everything visible: the shell keeps its 100dvh default.
    const viewport = stubVisualViewport(window.innerHeight)
    render(<Probe />)
    expect(appHeight()).toBe('')

    // iOS with its keyboard up: the layout viewport stays tall while the visible one shrinks.
    // The state settles inside an animation frame, which the `settle` wait wraps in act.
    viewport.height = 400
    viewport.offsetTop = 120
    viewport.dispatchEvent(new Event('resize'))
    await settle()
    expect(appHeight()).toBe('400px')

    // A delta this small is a collapsing URL bar, not a keyboard: back to 100dvh.
    viewport.height = window.innerHeight - 40
    viewport.offsetTop = 0
    viewport.dispatchEvent(new Event('resize'))
    await settle()
    expect(appHeight()).toBe('')
  })

  it('takes the keyboard away with it when the shell unmounts', async () => {
    stubVisualViewport(window.innerHeight - 400)
    render(<Probe />)
    await settle()
    expect(appHeight()).toBe(`${window.innerHeight - 400}px`)

    cleanup()
    expect(appHeight()).toBe('')
  })

  it('does nothing where the browser offers no visual viewport', () => {
    render(<Probe />)
    expect(appHeight()).toBe('')
  })
})
