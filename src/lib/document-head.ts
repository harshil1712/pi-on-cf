import appCss from '~/styles.css?url'

/** The document head: viewport, title, stylesheet, web app manifest and icons. */
export function documentHead() {
  return {
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        // viewport-fit: notches; resizes-content: Chrome shrinks the page, not just the visual viewport, when the keyboard opens.
        content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
      },
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
        // Browsers fetch the manifest without cookies unless asked, and Access answers a request without its cookie with a login redirect.
        crossOrigin: 'use-credentials' as const,
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
  }
}
