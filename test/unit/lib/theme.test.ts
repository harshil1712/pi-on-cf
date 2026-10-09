import { afterEach, describe, expect, it } from 'vitest'
import { applyThemePreference, THEME_COLORS, themeScript } from '~/lib/theme'

function themeColor() {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content')
}

afterEach(() => {
  document.head.innerHTML = ''
  localStorage.clear()
})

describe('theme', () => {
  it('points the browser chrome at the chosen mode, not the system one', () => {
    document.head.innerHTML = `<meta name="theme-color" content="${THEME_COLORS.light}">`
    applyThemePreference('dark')
    expect(document.documentElement.dataset.mode).toBe('dark')
    expect(themeColor()).toBe(THEME_COLORS.dark)
    applyThemePreference('light')
    expect(themeColor()).toBe(THEME_COLORS.light)
  })

  it('sets the stored mode and adds its theme-color before the first paint', () => {
    localStorage.setItem('pi-theme', 'dark')
    // The inline script, run as the browser would; it is our own constant, not input.
    // oxlint-disable-next-line no-implied-eval
    new Function(themeScript)()
    expect(document.documentElement.dataset.mode).toBe('dark')
    expect(themeColor()).toBe(THEME_COLORS.dark)
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
  })
})
