import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@cloudflare/kumo/components/tooltip'
import { AppShell } from '~/components/app-shell'
import { themeScript } from '~/lib/theme'
import appCss from '~/styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        // viewport-fit: notches; resizes-content: Chrome shrinks the page, not just the visual viewport, when the keyboard opens.
        content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
      },
      // The browser chrome follows the page's canvas colour, which Kumo switches with the colour scheme.
      { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#fbfbfb' },
      { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#030303' },
      {
        title: 'Pi on Cloudflare',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/manifest.webmanifest',
      },
      {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '192x192',
        href: '/icon-192.png',
      },
    ],
  }),
  shellComponent: RootDocument,
  component: AppShell,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-mode before hydration, so React must not reset it.
    <html lang="en" data-mode="light" suppressHydrationWarning>
      <head>
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
