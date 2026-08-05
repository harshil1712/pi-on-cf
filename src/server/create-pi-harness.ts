import { AgentHarness, Session, type AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { PiSessionStorage } from './pi-session-storage'

type CreatePiHarnessOptions = {
  env: Env
  sessionId: string
  storage: PiSessionStorage
  tools: AgentHarnessTool<undefined>[]
  memory: { getMemoryContext(): Promise<string> }
}

const BASE_SYSTEM_PROMPT = [
  'You are Pi running natively on Cloudflare Workers.',
  'Use the durable workspace tools to inspect and modify files.',
  'Workspace paths are absolute and rooted at /workspace in every backend.',
  'The exec tool has two Computer backends: shell is a fast just-bash environment with text utilities and Git; container provides Linux, native binaries, Node.js, npm, and network access.',
  'Use shell for ordinary file searches and text processing. Use container only when the task needs native execution, package installation, tests, builds, or networked CLI tools.',
  'Use the same /workspace paths with durable file tools, Worker Shell, Worker JavaScript, and container commands.',
  'The javascript tool runs isolated ECMAScript modules with structured input and output, durable imports, node:fs/promises, ws:git, and ws:artifacts.',
  'Files under /workspace/reference are a read-only R2 mount when configured. Use publish to share a generated file and artifacts to manage session-scoped repositories.',
  'The workspace starts empty. Call initialize_app only when the user asks to build an app.',
  'After app initialization, browser code is under /workspace/src and Worker API code is in /workspace/worker/index.ts.',
  'Use /api/* for Worker API routes and let non-API routes return 404 so the React single-page application can handle them.',
  'Keep the existing React and Cloudflare plugins in /workspace/vite.config.ts. Hosted builds do not run custom Vite plugins or package scripts.',
  'Use the memory tool only when the user directly asks to remember, save, correct, or forget something. Do not call it merely because they state a fact or preference; background extraction handles that.',
].join('\n')

export function createPiHarness({ env, sessionId, storage, tools, memory }: CreatePiHarnessOptions) {
  const gatewayId = env.AI_GATEWAY_ID || 'default'
  const modelId = env.AI_MODEL || 'anthropic/claude-sonnet-4-5'
  const model = gatewayModel(env, modelId)
  const memoryModel = gatewayModel(env, env.AI_MEMORY_MODEL || modelId)
  const providerModels = memoryModel.id === model.id ? [model] : [model, memoryModel]
  const models = createModels()
  models.setProvider(createProvider({
    id: model.provider,
    name: 'Cloudflare AI Gateway',
    auth: {
      apiKey: {
        name: 'Cloudflare API token',
        resolve: async () => ({
          auth: { apiKey: env.AI_GATEWAY_TOKEN, baseUrl: model.baseUrl },
          source: 'AI_GATEWAY_TOKEN',
        }),
      },
    },
    models: providerModels,
    api: { stream, streamSimple },
  }))

  return new AgentHarness({
    session: new Session(storage),
    models,
    model,
    tools,
    systemPrompt: async () => {
      try {
        return buildPiSystemPrompt(await memory.getMemoryContext())
      } catch (error) {
        console.error('Could not load long-term memory', error)
        return buildPiSystemPrompt('')
      }
    },
    thinkingLevel: 'medium',
    streamOptions: {
      headers: {
        'cf-aig-gateway-id': gatewayId,
        'cf-aig-metadata': JSON.stringify({ sessionId }),
      },
    },
  })
}

export function getMemoryModel(env: Env): Model<'openai-completions'> {
  return gatewayModel(env, env.AI_MEMORY_MODEL || env.AI_MODEL || 'anthropic/claude-sonnet-4-5')
}

export function buildPiSystemPrompt(memoryContext: string): string {
  return memoryContext ? `${BASE_SYSTEM_PROMPT}\n\n${memoryContext}` : BASE_SYSTEM_PROMPT
}

function gatewayModel(env: Env, modelId: string): Model<'openai-completions'> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const gatewayId = env.AI_GATEWAY_ID || 'default'
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'cloudflare-ai-gateway',
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    headers: { 'cf-aig-gateway-id': gatewayId },
  }
}

export type PiHarness = ReturnType<typeof createPiHarness>
