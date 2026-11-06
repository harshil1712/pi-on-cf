import type { ModelOption } from '~/contract'

/**
 * The Workers AI models a session can switch to. Curated rather than the
 * provider's whole catalog, which also lists models unfit for an agent:
 * these take tools and long contexts, and are not marked for deprecation
 * in the Workers AI model pages.
 */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' },
  { id: '@cf/zai-org/glm-5.3', label: 'GLM 5.3' },
]

/**
 * The curated list, led by the configured default, which is added when the
 * list lacks it. Leading with it lets a page that has no session yet, such as
 * the home page, preselect it.
 */
export function modelOptions(defaultId: string): ModelOption[] {
  const listed = MODEL_OPTIONS.find(({ id }) => id === defaultId) ?? { id: defaultId, label: defaultId }

  return [listed, ...MODEL_OPTIONS.filter(({ id }) => id !== defaultId)]
}
