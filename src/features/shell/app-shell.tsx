import { forwardRef } from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { Toasty } from '@cloudflare/kumo/components/toast'
import { type LinkComponentProps, LinkProvider } from '@cloudflare/kumo/utils'
import { SessionRegistryProvider } from '~/features/sessions/session-registry'
import { SessionSidebar } from '~/features/sessions/session-sidebar'

/** Kumo's links, the sidebar's included, navigate through the router. */
const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to: _to, ...props }, ref) => (
  <Link ref={ref} to={href ?? '/'} {...props} />
))
RouterLink.displayName = 'RouterLink'

/** Every page: the sessions sidebar beside the routed page. */
export function AppShell() {
  return (
    <LinkProvider component={RouterLink}>
      <Toasty>
        <SessionRegistryProvider>
          {/* A fixed height lets the sidebar fill it; each page scrolls inside. */}
          <Sidebar.Provider collapsible="offcanvas" className="h-dvh overflow-hidden">
            <SessionSidebar />
            <div className="flex h-dvh min-w-0 flex-1 flex-col">
              <Outlet />
            </div>
          </Sidebar.Provider>
        </SessionRegistryProvider>
      </Toasty>
    </LinkProvider>
  )
}
