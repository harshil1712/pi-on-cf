export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_STORAGE_KEY = 'pi-theme'

/**
 * Runs in <head> before first paint so the page never flashes the wrong
 * theme. Kumo's tokens switch on `data-mode` on the root element.
 */
export const themeScript = `(() => {
  try {
    const stored = localStorage.getItem('${THEME_STORAGE_KEY}')
    const dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.mode = dark ? 'dark' : 'light'
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
