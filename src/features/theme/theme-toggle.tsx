import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Monitor, Moon, Sun } from 'lucide-react'
import { applyThemePreference, readThemePreference, storeThemePreference, type ThemePreference } from './theme'

const NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function ThemeToggle() {
  // The server can't see the stored choice, so read it after hydration.
  const [preference, setPreference] = useState<ThemePreference>('system')

  useEffect(() => setPreference(readThemePreference()), [])

  // While following the system, track OS-level changes live.
  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => applyThemePreference('system')
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [preference])

  const Icon = preference === 'system' ? Monitor : preference === 'light' ? Sun : Moon
  const title = `Theme: ${LABEL[preference]} (switch to ${LABEL[NEXT[preference]].toLowerCase()})`

  return (
    <Button
      shape="square"
      size="sm"
      variant="ghost"
      className="theme-toggle"
      aria-label={title}
      title={title}
      onClick={() => {
        const next = NEXT[preference]
        storeThemePreference(next)
        setPreference(next)
      }}
      icon={<Icon size={15} />}
    />
  )
}
