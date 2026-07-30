import { describe, expect, it } from 'vitest'
import { buildApp } from './build-app'
import { hashSourceFiles } from './source'
import type { AppSourceFile } from './types'

const encoder = new TextEncoder()

describe('buildApp', () => {
  it('builds browser assets and a Worker from an in-memory source snapshot', async () => {
    const files: AppSourceFile[] = [
      { path: 'index.html', bytes: encoder.encode('<main></main><script type="module" src="/src/main.tsx"></script>') },
      { path: 'src/main.tsx', bytes: encoder.encode("document.querySelector('main')!.textContent = 'hello'") },
      { path: 'worker/index.ts', bytes: encoder.encode("export default { fetch() { return new Response('not found', { status: 404 }) } }") },
      { path: 'wrangler.jsonc', bytes: encoder.encode('{ "compatibility_date": "2026-07-30" }') },
      { path: 'public/icon.bin', bytes: new Uint8Array([0, 255, 64]) },
    ]
    const hash = await hashSourceFiles(files)

    const built = await buildApp({ files, hash, totalBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0) })

    expect(built.sourceHash).toBe(hash)
    expect(built.compatibilityDate).toBe('2026-07-27')
    expect(built.modules[built.mainModule]).toBeDefined()
    expect(built.assets['/index.html']).toBeDefined()
    expect(new Uint8Array(built.assets['/icon.bin'] as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 64]))
    expect(built.bundleHash).toMatch(/^[0-9a-f]{64}$/)
  }, 20_000)
})
