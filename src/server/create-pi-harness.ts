import { AgentHarness, Session, type AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { PiSessionStorage } from './pi-session-storage'

type CreatePiHarnessOptions = {
  env: Env
  sessionId: string
  storage: PiSessionStorage
  tools: AgentHarnessTool<undefined>[]
}

export function createPiHarness({ env, sessionId, storage, tools }: CreatePiHarnessOptions) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const gatewayId = env.AI_GATEWAY_ID || 'default'
  const modelId = env.AI_MODEL || 'anthropic/claude-sonnet-4-5'
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: env.AI_MODEL || 'Anthropic Claude Sonnet',
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
  const models = createModels()
  models.setProvider(createProvider({
    id: model.provider,
    name: 'Cloudflare AI Gateway',
    auth: {
      apiKey: {
        name: 'Cloudflare API token',
        resolve: async () => ({
          auth: { apiKey: env.CLOUDFLARE_API_TOKEN, baseUrl: model.baseUrl },
          source: 'CLOUDFLARE_API_TOKEN',
        }),
      },
    },
    models: [model],
    api: { stream, streamSimple },
  }))

  return new AgentHarness({
    session: new Session(storage),
    models,
    model,
    tools,
    systemPrompt: [
      'You are Pi running natively on Cloudflare Workers.',
      'Use the durable workspace tools to inspect and modify files.',
      'There is no POSIX filesystem or native process runtime. Do not claim to run shell commands.',
      'Workspace paths are absolute and rooted at /.',
    ].join('\n'),
    thinkingLevel: 'medium',
    streamOptions: {
      headers: {
        'cf-aig-gateway-id': gatewayId,
        'cf-aig-metadata': JSON.stringify({ sessionId }),
      },
    },
  })
}

export type PiHarness = ReturnType<typeof createPiHarness>
