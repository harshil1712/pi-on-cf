import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ThemeToggle } from '~/features/theme/theme-toggle'

/** The π mark, the one place the brand orange appears. */
export function PiMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center bg-pi-brand leading-none font-bold text-white',
        size === 'sm' ? 'size-6 rounded-md text-[15px]' : 'size-9 rounded-lg text-[22px]',
      )}
    >
      π
    </span>
  )
}

/** Shared page header: a leading slot, then actions and the theme menu on the right. */
export function TopBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-2.5 border-b border-kumo-hairline bg-kumo-base pr-3 pl-4">
      {children}
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        {actions}
      </div>
    </header>
  )
}
