import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type Provider,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import type { PiModel } from 'agents/harness/pi'
import { PiSession as AppPiSession } from './server/pi-session'

export { PiRegistry } from './server/pi-registry'
export { ComputerTest } from './server/computer-test'
export { WorkspaceProxy, WorkspaceServiceProxy } from '@cloudflare/computer'

function textOf(content: Message['content'] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('')
}

/**
 * The faux model, derived from the transcript alone:
 * - `write <path> <text>` calls Computer's `write` tool.
 * - `exec <backend> <command>` calls Computer's `exec` tool.
 * - After a tool result it answers `tool said: <result>`.
 * - Anything else is echoed back.
 */
function script(context: TranscriptContext): AssistantMessage {
  // pi places system-prompt changes positionally, so one can follow the input.
  const last = context.messages.filter((message) => message.role !== 'system').at(-1)
  if (last?.role === 'toolResult') {
    return fauxAssistantMessage([fauxText(`${last.isError ? 'tool failed' : 'tool said'}: ${textOf(last.content)}`)])
  }
  const prompt = last?.role === 'user' ? textOf(last.content) : ''
  const exec = /^exec (\S+) ([\s\S]+)$/.exec(prompt)
  if (exec) {
    return fauxAssistantMessage([fauxToolCall('exec', { backend: exec[1], command: exec[2] })], { stopReason: 'toolUse' })
  }
  const write = /^write (\S+) (.+)$/.exec(prompt)
  if (write) {
    return fauxAssistantMessage([fauxToolCall('write', { path: write[1], content: write[2] })], { stopReason: 'toolUse' })
  }
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)])
}

/** The application's PiSession, with pi-ai's faux provider instead of Workers AI. */
export class PiSession extends AppPiSession {
  protected override modelSource(): { provider: Provider; default: PiModel } {
    const faux = fauxProvider({ tokensPerSecond: 500 })
    faux.setResponses(Array.from({ length: 100 }, () => script))
    return { provider: faux.provider, default: faux.getModel() }
  }

  /** Submit and wait for pi's answer: its status, text and the transcript entry kinds. */
  async promptForTest(prompt: string): Promise<{ status: string; text?: string; kinds: string[] }> {
    const result = await this.harness.prompt(prompt)
    return { status: result.status, text: result.text, kinds: result.messages.map((entry) => entry.kind) }
  }
}

export default {
  fetch() {
    return new Response('Not found', { status: 404 })
  },
}
