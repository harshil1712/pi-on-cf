export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_STORAGE_KEY = 'pi-theme'

/** Kumo's canvas colour in each mode, which the browser chrome (`theme-color`) follows. */
export const THEME_COLORS = { light: '#fbfbfb', dark: '#030303' } as const

/**
 * Runs in <head> before first paint so the page never flashes the wrong
 * theme. Kumo's tokens switch on `data-mode` on the root element.
 *
 * It also adds the `theme-color` meta, so the browser chrome follows the
 * mode, including the toggle, which a media query could not. The head
 * config can't hold it: HeadContent keeps only the first meta of each name,
 * so a light/dark pair loses one, and React re-adds a server-rendered meta
 * whose content this script changed, leaving two.
 */
export const themeScript = `(() => {
  try {
    const stored = localStorage.getItem('${THEME_STORAGE_KEY}')
    const dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.mode = dark ? 'dark' : 'light'
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = dark ? '${THEME_COLORS.dark}' : '${THEME_COLORS.light}'
    document.head.append(meta)
  } catch {}
})()`

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyThemePreference(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && systemPrefersDark())
  document.documentElement.dataset.mode = dark ? 'dark' : 'light'
  // The theme script added this tag before hydration.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[dark ? 'dark' : 'light'])
}

export function storeThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Storage can be unavailable (private mode); the choice still applies for this page.
  }
  applyThemePreference(preference)
}
