import type { BuiltApp } from './types'

const encoder = new TextEncoder()

type App = BuiltApp

export async function previewApp(request: Request, builtApp: BuiltApp, loader: WorkerLoader): Promise<Response> {
  const app = builtApp
  const worker = loader.get(app.bundleHash, () => previewCode(app))
  return worker.getEntrypoint().fetch(request)
}

async function previewCode(app: App): Promise<WorkerLoaderWorkerCode> {
  const modules = { ...app.modules }
  let wrapper = '__preview_runtime.js'
  let userMain = app.mainModule

  if (userMain === wrapper) {
    userMain = uniqueName('__preview_user.js', modules)
    modules[userMain] = modules[app.mainModule]
    delete modules[app.mainModule]
  } else if (wrapper in modules) {
    wrapper = uniqueName(wrapper, modules)
  }

  const imports: string[] = []
  const manifest: Array<{ path: string; name: string; type: string; etag: string }> = []
  let index = 0
  for (const [rawPath, value] of Object.entries(app.assets).sort(([a], [b]) => a.localeCompare(b))) {
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const data = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value)
    const moduleName = uniqueName(`__preview_asset_${index}.bin`, modules)
    const importName = `asset${index++}`
    modules[moduleName] = { data: data.slice().buffer as ArrayBuffer }
    imports.push(`import ${importName} from ${JSON.stringify(specifier(moduleName))};`)
    manifest.push({ path, name: importName, type: contentType(path), etag: `"${await sha256(data)}"` })
  }

  modules[wrapper] = {
    js: `${imports.join('')}import user from ${JSON.stringify(specifier(userMain))};
const assets=new Map([${manifest.map((asset) => `[${JSON.stringify(asset.path)},{body:${asset.name},type:${JSON.stringify(asset.type)},etag:${JSON.stringify(asset.etag)}}]`).join(',')}]);
function serve(request,asset){const headers=new Headers({"content-type":asset.type,etag:asset.etag});if(request.headers.get("if-none-match")===asset.etag)return new Response(null,{status:304,headers});return new Response(request.method==="HEAD"?null:asset.body,{headers})}
export default{async fetch(request,env,ctx){const url=new URL(request.url);const asset=assets.get(url.pathname);if(asset&&(request.method==="GET"||request.method==="HEAD"))return serve(request,asset);const response=await user.fetch(request,env,ctx);if(url.pathname.startsWith("/api")||response.status!==404)return response;const index=assets.get("/index.html");if(index&&request.method==="GET"&&(request.headers.get("accept")||"").includes("text/html"))return serve(request,index);return response}};`,
  }

  return {
    mainModule: wrapper,
    modules,
    compatibilityDate: app.compatibilityDate,
    compatibilityFlags: app.compatibilityFlags,
    limits: { cpuMs: 50, subRequests: 20 },
    env: {},
  }
}

function uniqueName(preferred: string, modules: WorkerLoaderWorkerCode['modules']): string {
  if (!(preferred in modules)) return preferred
  let index = 1
  while (`${preferred}.${index}` in modules) index++
  return `${preferred}.${index}`
}

function specifier(moduleName: string): string {
  return moduleName.startsWith('.') ? moduleName : `./${moduleName.replace(/^\//, '')}`
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return ({
    '.avif': 'image/avif', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
