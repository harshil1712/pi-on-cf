import type { Modules } from '@cloudflare/worker-bundler'

export type AppSourceFile = {
  path: string
  bytes: Uint8Array
}

export type AppSourceSnapshot = {
  hash: string
  files: AppSourceFile[]
  totalBytes: number
}

export type SourceFile = AppSourceFile
export type SourceSnapshot = AppSourceSnapshot

export type TemplateSourceSummary = {
  repository: string
  commit: string
  fileCount: number
  totalBytes: number
}

export type BuiltApp = {
  sourceHash: string
  bundleHash: string
  mainModule: string
  modules: Modules
  assets: Record<string, string | ArrayBuffer>
  compatibilityDate: string
  compatibilityFlags: string[]
}

export type DeploymentSummary = {
  sourceHash: string
  bundleHash: string
  templateCommit: string
  commitSha: string
  workerId: string
  workerName: string
  versionId: string
  deploymentId: string
  productionUrl: string
  deployedAt: string
}
