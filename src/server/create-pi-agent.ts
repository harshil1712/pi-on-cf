import { Agent as PiAgent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Model } from '@earendil-works/pi-ai'

type CreatePiAgentOptions = {
  env: Env
  messages: AgentMessage[]
  sessionId: string
  tools: AgentTool[]
}

export function createPiAgent({ env, messages, sessionId, tools }: CreatePiAgentOptions) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const gatewayId = env.AI_GATEWAY_ID || 'default'
  const model: Model<'openai-completions'> = {
    id: env.AI_MODEL || 'anthropic/claude-sonnet-4-5',
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

  return new PiAgent({
    initialState: {
      systemPrompt: [
        'You are Pi running natively on Cloudflare Workers.',
        'Use the durable workspace tools to inspect and modify files.',
        'Workspace paths are absolute and rooted at /.',
        'The exec tool runs a just-bash shell rooted at /. It supports common text utilities and Git, but not native binaries such as node, npm, or python.',
      ].join('\n'),
      model,
      messages,
      tools,
      thinkingLevel: 'medium',
    },
    sessionId,
    toolExecution: 'sequential',
    streamFn: (activeModel, context, options) =>
      streamSimple(activeModel as Model<'openai-completions'>, context, {
        ...options,
        apiKey: env.AI_GATEWAY_TOKEN,
        headers: {
          ...activeModel.headers,
          'cf-aig-metadata': JSON.stringify({ sessionId }),
        },
      }),
  })
}
