import { useEffect } from 'react'

/**
 * iOS Safari keeps the layout viewport at full height when the soft keyboard
 * opens: only the visual viewport shrinks, so the composer ends up underneath
 * the keys. (`interactive-widget=resizes-content` already makes Chrome resize
 * the page itself.) While a keyboard plausibly covers the bottom of the
 * screen, pin the app's height to the visible part through `--app-height`,
 * which the app shell renders at instead of `100dvh`.
 */
export function useKeyboardAwareHeight() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let frame: number | null = null
    const sync = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null
        // A collapsing URL bar hides behind a small delta; a keyboard is tall.
        // Pinch-zoom shrinks the visual viewport too, but leaves the layout alone.
        const covered = window.innerHeight - viewport.height - viewport.offsetTop
        const keyboard = covered > 120 && viewport.scale <= 1.01
        document.documentElement.style.setProperty('--app-height', keyboard ? `${viewport.height}px` : '')
      })
    }
    viewport.addEventListener('resize', sync)
    viewport.addEventListener('scroll', sync)
    sync()
    return () => {
      viewport.removeEventListener('resize', sync)
      viewport.removeEventListener('scroll', sync)
      if (frame !== null) cancelAnimationFrame(frame)
      document.documentElement.style.removeProperty('--app-height')
    }
  }, [])
}
