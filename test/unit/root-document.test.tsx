import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Route } from '~/routes/__root'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')

/** A PNG's dimensions from its IHDR chunk, all a manifest's `sizes` needs to match. */
function pngSize(path: string) {
  const png = readFileSync(path)
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  expect(png.subarray(12, 16).toString()).toBe('IHDR')
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
}

describe('the root document', () => {
  // The head is plain HTML attributes; TanStack types them as React props in unions, which is no use here.
  const { meta, links } = (Route.options.head as unknown as () => { meta: Array<Record<string, string>>; links: Array<Record<string, string>> })()

  const named = (name: string) => meta.filter((entry) => 'name' in entry && entry.name === name)

  it('keeps the composer above the soft keyboard and clear of the notch', () => {
    const viewport = named('viewport').at(0)?.content ?? ''
    // Chrome resizes the page for the keyboard; the notch needs the viewport extended.
    expect(viewport).toContain('interactive-widget=resizes-content')
    expect(viewport).toContain('viewport-fit=cover')
  })

  it('leaves theme-color to the theme script', () => {
    // HeadContent keeps one meta per name, and React would re-add one whose content the script changed.
    expect(named('theme-color')).toEqual([])
  })

  it('offers an installable app whose files all exist', () => {
    const manifestLink = links.find((link) => link.rel === 'manifest')
    expect(manifestLink?.href).toBe('/manifest.webmanifest')
    // Behind Access, a manifest fetched without cookies gets the login redirect instead.
    expect(manifestLink?.crossOrigin).toBe('use-credentials')

    const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8')) as {
      display: string
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>
    }
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      expect(pngSize(join(publicDir, icon.src.slice(1)))).toBe(icon.sizes)
    }
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)

    // The head's apple-touch-icon and favicon links must name real files too.
    const touchIcon = links.find((link) => link.rel === 'apple-touch-icon')
    expect(pngSize(join(publicDir, touchIcon!.href.slice(1)))).toBe('180x180')
    const icon = links.find((link) => link.rel === 'icon')
    expect(pngSize(join(publicDir, icon!.href.slice(1)))).toBe(icon!.sizes)
  })
})
