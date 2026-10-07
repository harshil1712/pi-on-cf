import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown'
import { MonitorIcon, MoonIcon, SunIcon } from '@phosphor-icons/react'
import { applyThemePreference, readThemePreference, storeThemePreference, type ThemePreference } from './theme'

const OPTIONS = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; icon: unknown }>

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

  const current = OPTIONS.find((option) => option.value === preference) ?? OPTIONS[0]
  const CurrentIcon = current.icon

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button shape="square" size="sm" variant="ghost" aria-label={`Theme: ${current.label}`} icon={<CurrentIcon size={16} />} />} />
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup
          value={preference}
          onValueChange={(value: ThemePreference) => {
            storeThemePreference(value)
            setPreference(value)
          }}
        >
          {OPTIONS.map(({ value, label, icon }) => (
            <DropdownMenu.RadioItem key={value} value={value} icon={icon}>
              {label}
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
