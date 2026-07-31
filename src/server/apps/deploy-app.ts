import type { Modules } from '@cloudflare/worker-bundler'
import type { ComputerWorkspace } from '../computer-workspace'
import { AppArtifactsRepository } from './artifacts-repository'
import type { AppSourceSnapshot, BuiltApp, DeploymentSummary, TemplateSourceSummary } from './types'
import { WorkersClient, type WorkerModule } from './workers-client'

type DeployAppOptions = {
  env: Env
  sessionId: string
  workspace: ComputerWorkspace
  source: AppSourceSnapshot
  built: BuiltApp
  template: TemplateSourceSummary
}

export async function deployApp({ env, sessionId, workspace, source, built, template }: DeployAppOptions): Promise<DeploymentSummary> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.WORKERS_DEPLOY_API_TOKEN) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and WORKERS_DEPLOY_API_TOKEN must be configured.')
  }
  const repositoryName = `${env.APP_REPOSITORY_PREFIX || 'pi-app'}-${sessionId}`
  const workerName = `${env.APP_WORKER_PREFIX || 'pi-app'}-${sessionId}`
  const repository = new AppArtifactsRepository(
    env.APP_ARTIFACTS,
    repositoryName,
    env.APP_ARTIFACTS_NAMESPACE || 'pi-apps',
    env.CLOUDFLARE_ACCOUNT_ID,
    workspace,
    template.repository,
    template.commit,
  )
  const commitSha = await repository.publish(source)
  const deployed = await new WorkersClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.WORKERS_DEPLOY_API_TOKEN,
  }).deploy({
    name: workerName,
    modules: workerModules(built.modules),
    assets: Object.entries(built.assets).map(([path, content]) => ({
      path,
      content: typeof content === 'string' ? content : new Uint8Array(content),
      contentType: contentType(path),
    })),
    config: {
      mainModule: built.mainModule,
      compatibilityDate: built.compatibilityDate,
      compatibilityFlags: built.compatibilityFlags,
      assets: { notFoundHandling: 'single-page-application' },
    },
  })
  return {
    sourceHash: source.hash,
    bundleHash: built.bundleHash,
    templateCommit: template.commit,
    commitSha,
    workerId: deployed.workerId,
    workerName,
    versionId: deployed.versionId,
    deploymentId: deployed.deploymentId,
    productionUrl: deployed.productionUrl,
    deployedAt: new Date().toISOString(),
  }
}

function workerModules(modules: Modules): WorkerModule[] {
  return Object.entries(modules).map(([name, module]) => {
    if (typeof module === 'string') return { name, content: module, contentType: 'application/javascript+module' }
    if (module.js !== undefined) return { name, content: module.js, contentType: 'application/javascript+module' }
    if (module.cjs !== undefined) return { name, content: module.cjs, contentType: 'application/javascript' }
    if (module.text !== undefined) return { name, content: module.text, contentType: 'text/plain' }
    if (module.data !== undefined) return { name, content: new Uint8Array(module.data), contentType: 'application/octet-stream' }
    if (module.json !== undefined) return { name, content: JSON.stringify(module.json), contentType: 'application/json' }
    throw new Error(`Unsupported Worker module: ${name}`)
  })
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return ({
    '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html', '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}
