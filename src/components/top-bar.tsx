import type { ReactNode } from 'react'
import { Sidebar, useSidebar } from '@cloudflare/kumo/components/sidebar'
import { cn } from '@cloudflare/kumo/utils'

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
