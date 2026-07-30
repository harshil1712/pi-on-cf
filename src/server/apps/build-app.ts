import { createApp, type Modules } from '@cloudflare/worker-bundler'
import type { Plugin } from 'esbuild-wasm'
import type { AppSourceSnapshot, BuiltApp } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const compatibilityDate = '2026-07-27'
const compatibilityFlags = ['nodejs_compat']
const imagePattern = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i

type Snapshot = {
  files: Array<{ path: string; bytes?: Uint8Array | ArrayBuffer; content?: Uint8Array | ArrayBuffer; contentType?: string }>
  sourceHash?: string
  hash?: string
}

export async function buildApp(snapshot: AppSourceSnapshot): Promise<BuiltApp> {
  const source = snapshot as Snapshot
  const raw = new Map(source.files.map((file) => [cleanPath(file.path), bytes(file)]))
  const files: Record<string, string> = {}
  const assets: Record<string, string | ArrayBuffer> = {}

  for (const file of source.files) {
    const path = cleanPath(file.path)
    const content = bytes(file)
    if (path === 'index.html') {
      const html = decoder.decode(content).replaceAll('/src/main.tsx', '/main.js')
      files[path] = html
      assets['/index.html'] = html
    } else if (path.startsWith('public/')) {
      assets[`/${path.slice(7)}`] = arrayBuffer(content)
    } else if (!imagePattern.test(path)) {
      files[path] = decoder.decode(content)
    }
  }

  const sourcePlugin: Plugin = {
    name: 'app-binary-and-css',
    setup(build) {
      build.onResolve({ filter: /\.(?:avif|css|gif|ico|jpe?g|png|svg|webp)$/i }, (args) => {
        const path = resolvePath(args.importer, args.path)
        return raw.has(path) ? { path, namespace: 'app-source' } : undefined
      })
      build.onLoad({ filter: imagePattern, namespace: 'app-source' }, (args) => ({
        contents: raw.get(args.path),
        loader: 'dataurl',
      }))
      build.onLoad({ filter: /\.css$/i, namespace: 'app-source' }, (args) => ({
        contents: `const css=${JSON.stringify(decoder.decode(raw.get(args.path)))};if(typeof document!=="undefined"){const s=document.createElement("style");s.textContent=css;document.head.append(s)}`,
        loader: 'js',
      }))
    },
  }

  const result = await createApp({
    files,
    server: 'worker/index.ts',
    client: 'src/main.tsx',
    assets,
    assetConfig: { not_found_handling: 'single-page-application' },
    jsx: 'automatic',
    jsxImportSource: 'react',
    minify: true,
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.MODE': '"production"',
      'process.env.NODE_ENV': '"production"',
    },
    __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [sourcePlugin] as unknown[],
  })

  const date = compatibilityDate
  const flags = result.wranglerConfig?.compatibilityFlags ?? compatibilityFlags
  const built = {
    sourceHash: source.sourceHash ?? source.hash ?? '',
    bundleHash: await hashBundle(result.mainModule, result.modules, result.assets, date, flags),
    mainModule: result.mainModule,
    modules: result.modules,
    assets: result.assets,
    compatibilityDate: date,
    compatibilityFlags: flags,
  }
  return built
}

function bytes(file: Snapshot['files'][number]): Uint8Array {
  const value = file.bytes ?? file.content
  if (!value) throw new Error(`Source file has no bytes: ${file.path}`)
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function cleanPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\//, '')
}

function resolvePath(importer: string, imported: string): string {
  if (imported.startsWith('/')) return cleanPath(imported)
  const parts = `${importer.slice(0, importer.lastIndexOf('/') + 1)}${imported}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  return cleanPath(resolved.join('/'))
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer
}

async function hashBundle(
  mainModule: string,
  modules: Modules,
  assets: Record<string, string | ArrayBuffer>,
  date: string,
  flags: string[],
): Promise<string> {
  const chunks: Uint8Array[] = [encoder.encode(JSON.stringify([mainModule, date, flags]))]
  for (const [path, module] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    chunks.push(encoder.encode(path), moduleBytes(module))
  }
  for (const [path, asset] of Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))) {
    chunks.push(encoder.encode(path), typeof asset === 'string' ? encoder.encode(asset) : new Uint8Array(asset))
  }
  const size = chunks.reduce((total, chunk) => total + 4 + chunk.byteLength, 0)
  const input = new Uint8Array(size)
  const view = new DataView(input.buffer)
  let offset = 0
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.byteLength)
    input.set(chunk, offset + 4)
    offset += chunk.byteLength + 4
  }
  return hex(await crypto.subtle.digest('SHA-256', input.buffer))
}

function moduleBytes(module: Modules[string]): Uint8Array {
  if (typeof module === 'string') return encoder.encode(module)
  if (module.data) return new Uint8Array(module.data)
  return encoder.encode(JSON.stringify(module))
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
