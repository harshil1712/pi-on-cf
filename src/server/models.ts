import type { ModelOption } from '~/shared/pi-contract'

/**
 * The Workers AI models a session can switch to. Curated rather than the
 * provider's whole catalog, which also lists models unfit for an agent:
 * these take tools and long contexts.
 */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: '@cf/zai-org/glm-5.2', label: 'GLM 5.2' },
  { id: '@cf/zai-org/glm-5.3', label: 'GLM 5.3' },
  { id: '@cf/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { id: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro' },
  { id: '@cf/openai/gpt-oss-120b', label: 'gpt-oss 120B' },
]

/** The curated list, led by the configured default when the list lacks it. */
export function modelOptions(defaultId: string): ModelOption[] {
  return MODEL_OPTIONS.some(({ id }) => id === defaultId)
    ? [...MODEL_OPTIONS]
    : [{ id: defaultId, label: defaultId }, ...MODEL_OPTIONS]
}
