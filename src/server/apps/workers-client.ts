import { blake3 } from "@noble/hashes/blake3.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

export type WorkerContent = string | Uint8Array;

export interface WorkerModule {
  name: string;
  content: WorkerContent;
  contentType: string;
}

export interface WorkerAsset {
  path: string;
  content: WorkerContent;
  contentType?: string;
}

export interface WorkerVersionConfig {
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  bindings?: Array<Record<string, unknown>>;
  assets?: {
    htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
    notFoundHandling?: "none" | "404-page" | "single-page-application";
    runWorkerFirst?: boolean | string[];
  };
}

export interface DeployWorkerInput {
  name: string;
  modules: WorkerModule[];
  assets?: WorkerAsset[];
  config: WorkerVersionConfig;
}

export interface DeployWorkerResult {
  workerId: string;
  versionId: string;
  deploymentId: string;
  productionUrl: string;
}

export interface WorkersClientOptions {
  accountId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

interface ApiMessage {
  code?: number;
  message?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: ApiMessage[];
  messages?: ApiMessage[];
}

interface AssetUploadSession {
  buckets: string[][];
  jwt: string;
}

interface AssetEntry {
  hash: string;
  size: number;
  contentBase64: string;
  contentType?: string;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export class WorkersClient {
  readonly #accountId: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor({ accountId, token, fetch: fetchDependency = globalThis.fetch }: WorkersClientOptions) {
    if (!accountId || !token) throw new Error("Cloudflare accountId and token are required");
    if (!fetchDependency) throw new Error("A fetch implementation is required");
    this.#accountId = accountId;
    this.#token = token;
    this.#fetch = fetchDependency;
  }

  async deploy(input: DeployWorkerInput): Promise<DeployWorkerResult> {
    if (!input.name || !input.modules.length) throw new Error("Worker name and at least one module are required");
    if (!input.modules.some((module) => module.name === input.config.mainModule)) {
      throw new Error(`Main module ${input.config.mainModule} is not present in modules`);
    }

    const workerId = await this.#ensureWorker(input.name);
    const assets = await this.#prepareAssets(input.assets ?? []);
    const manifest = Object.fromEntries(
      [...assets].map(([path, asset]) => [path, { hash: asset.hash, size: asset.size }]),
    );
    const session = await this.#api<AssetUploadSession>(
      `/workers/scripts/${encodeURIComponent(input.name)}/assets-upload-session`,
      { method: "POST", body: JSON.stringify({ manifest }) },
      "create asset upload session",
    );
    if (!session.jwt || !Array.isArray(session.buckets)) {
      throw new Error("Cloudflare returned an invalid asset upload session");
    }

    let assetsJwt = session.buckets.some((bucket) => bucket.length > 0) ? "" : session.jwt;
    for (const bucket of session.buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const asset = [...assets.values()].find((candidate) => candidate.hash === hash);
        if (!asset) throw new Error(`Cloudflare requested unknown asset hash ${hash}`);
        form.append(hash, new Blob([asset.contentBase64], { type: asset.contentType ?? "application/null" }), hash);
      }
      const uploaded = await this.#api<{ jwt?: string }>(
        "/workers/assets/upload?base64=true",
        { method: "POST", headers: { Authorization: `Bearer ${session.jwt}` }, body: form },
        "upload asset bucket",
        false,
      );
      if (uploaded.jwt) assetsJwt = uploaded.jwt;
    }

    if (!assetsJwt) throw new Error("Cloudflare did not return an assets completion JWT");
    const assetConfig = input.config.assets;
    const version = await this.#api<{ id: string }>(
      `/workers/workers/${encodeURIComponent(workerId)}/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          main_module: input.config.mainModule,
          compatibility_date: input.config.compatibilityDate,
          ...(input.config.compatibilityFlags && { compatibility_flags: input.config.compatibilityFlags }),
          ...(input.config.bindings && { bindings: input.config.bindings }),
          modules: input.modules.map((module) => ({
            name: module.name,
            content_type: module.contentType,
            content_base64: toBase64(toBytes(module.content)),
          })),
          assets: {
            jwt: assetsJwt,
            ...(assetConfig && {
              config: {
                ...(assetConfig.htmlHandling && { html_handling: assetConfig.htmlHandling }),
                ...(assetConfig.notFoundHandling && { not_found_handling: assetConfig.notFoundHandling }),
                ...(assetConfig.runWorkerFirst !== undefined && { run_worker_first: assetConfig.runWorkerFirst }),
              },
            }),
          },
        }),
      },
      "create Worker version",
    );
    if (!version.id) throw new Error("Cloudflare did not return a Worker version ID");

    const deployment = await this.#api<{ id: string }>(
      `/workers/scripts/${encodeURIComponent(input.name)}/deployments`,
      {
        method: "POST",
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ version_id: version.id, percentage: 100 }],
        }),
      },
      "create Worker deployment",
    );
    if (!deployment.id) throw new Error("Cloudflare did not return a Worker deployment ID");
    const subdomain = await this.#api<{ subdomain: string }>(
      "/workers/subdomain",
      {},
      "get workers.dev subdomain",
    );
    if (!subdomain.subdomain) throw new Error("Cloudflare did not return a workers.dev subdomain");
    return {
      workerId,
      versionId: version.id,
      deploymentId: deployment.id,
      productionUrl: `https://${input.name}.${subdomain.subdomain}.workers.dev`,
    };
  }

  async deleteWorker(name: string): Promise<void> {
    if (!name) throw new Error("Worker name is required");
    try {
      await this.#api<unknown>(
        `/workers/workers/${encodeURIComponent(name)}`,
        { method: "DELETE" },
        `delete Worker ${name}`,
      );
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
  }

  async #ensureWorker(name: string): Promise<string> {
    try {
      const worker = await this.#api<{ id?: string; name?: string }>(
        `/workers/workers/${encodeURIComponent(name)}`,
        {},
        `get Worker ${name}`,
      );
      return worker.id ?? worker.name ?? name;
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    const worker = await this.#api<{ id?: string; name?: string }>(
      "/workers/workers",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          subdomain: { enabled: true, previews_enabled: false },
          observability: { enabled: true },
        }),
      },
      `create Worker ${name}`,
    );
    return worker.id ?? worker.name ?? name;
  }

  async #prepareAssets(input: WorkerAsset[]): Promise<Map<string, AssetEntry>> {
    const assets = new Map<string, AssetEntry>();
    for (const asset of input) {
      if (!asset.path) throw new Error("Asset path is required");
      if (assets.has(asset.path)) throw new Error(`Duplicate asset path ${asset.path}`);
      const bytes = toBytes(asset.content);
      const contentBase64 = toBase64(bytes);
      const filename = asset.path.split("/").at(-1) ?? "";
      const dot = filename.lastIndexOf(".");
      const extension = dot > 0 ? filename.slice(dot + 1) : "";
      const digest = blake3(new TextEncoder().encode(contentBase64 + extension));
      const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
      assets.set(asset.path, { hash, size: bytes.byteLength, contentBase64, contentType: asset.contentType });
    }
    return assets;
  }

  async #api<T>(path: string, init: RequestInit, operation: string, accountAuth = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (accountAuth) headers.set("Authorization", `Bearer ${this.#token}`);
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}/accounts/${encodeURIComponent(this.#accountId)}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new Error(`Cloudflare ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let envelope: ApiEnvelope<T> | undefined;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new CloudflareApiError(`Cloudflare ${operation} failed with HTTP ${response.status}: invalid JSON response`, response.status);
    }
    if (!response.ok || envelope.success !== true) {
      const details = [...(envelope.errors ?? []), ...(envelope.messages ?? [])]
        .map(({ code, message }) => `${code ? `${code}: ` : ""}${message ?? "Unknown error"}`)
        .join("; ");
      throw new CloudflareApiError(
        `Cloudflare ${operation} failed with HTTP ${response.status}${details ? `: ${details}` : ""}`,
        response.status,
      );
    }
    if (!("result" in envelope)) {
      throw new CloudflareApiError(`Cloudflare ${operation} returned no result`, response.status);
    }
    return envelope.result;
  }
}

function toBytes(content: WorkerContent): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
