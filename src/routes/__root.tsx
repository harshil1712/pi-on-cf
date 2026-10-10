import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@cloudflare/kumo/components/tooltip'
import { AppShell } from '~/components/app-shell'
import { documentHead } from '~/lib/document-head'
import { themeScript } from '~/lib/theme'

export const Route = createRootRoute({
  head: documentHead,
  shellComponent: RootDocument,
  component: AppShell,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-mode before hydration, so React must not reset it.
    <html lang="en" data-mode="light" suppressHydrationWarning>
      <head>
        {/* Sets the mode and adds the theme-color meta that follows it; see themeScript. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Scripts />
      </body>
    </html>
  )
}
