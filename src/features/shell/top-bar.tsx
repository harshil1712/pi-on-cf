import type { ReactNode } from 'react'
import { Sidebar, useSidebar } from '@cloudflare/kumo/components/sidebar'
import { cn } from '@cloudflare/kumo/utils'

/** The π mark, the one place the brand orange appears. */
export function PiMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center bg-pi-brand leading-none font-bold text-white',
        size === 'sm' ? 'size-6 rounded-md text-[15px]' : 'size-11 rounded-xl text-[26px]',
      )}
    >
      π
    </span>
  )
}

/**
 * Shared page header, as tall as the sidebar's so their borders line up.
 * It offers the sidebar trigger only when the sidebar is out of view.
 */
export function TopBar({ children, actions, bordered = true }: { children?: ReactNode; actions?: ReactNode; bordered?: boolean }) {
  const { open, isMobile } = useSidebar()
  return (
    <header className={cn('flex h-[58px] shrink-0 items-center gap-2 pr-3 pl-3', bordered && 'border-b border-kumo-line bg-kumo-base')}>
      {(isMobile || !open) && <Sidebar.Trigger aria-label="Show sessions" title="Sessions" />}
      {children}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </header>
  )
}
