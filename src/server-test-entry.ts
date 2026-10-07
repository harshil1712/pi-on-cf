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
import type { SkillSource } from 'agents/skills'
import { PiRegistry as AppPiRegistry } from './server/pi-registry'
import { PiSession as AppPiSession } from './server/pi-session'
import { bucketSkills } from './server/skills'

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
 * - `skill <name>` calls `activate_skill`.
 * - `resource <name> <path>` calls `read_skill_resource`.
 * - `catalog` answers with the `skills` prompt section the model sees.
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
  if (prompt === 'catalog') {
    // Replaying system messages in order yields the current sections.
    let catalog: string | null = null
    for (const message of context.messages) {
      if (message.role === 'system' && message.sections && 'skills' in message.sections) catalog = message.sections.skills ?? null
    }
    return fauxAssistantMessage([fauxText(`catalog: ${catalog ?? 'none'}`)])
  }
  const resource = /^resource (\S+) (\S+)$/.exec(prompt)
  if (resource) {
    return fauxAssistantMessage([fauxToolCall('read_skill_resource', { name: resource[1], path: resource[2] })], { stopReason: 'toolUse' })
  }
  const skill = /^skill (\S+)$/.exec(prompt)
  if (skill) {
    return fauxAssistantMessage([fauxToolCall('activate_skill', { name: skill[1] })], { stopReason: 'toolUse' })
  }
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

  /** The app's bucket source, listing on every refresh so tests see changes at once. */
  protected override skillSources(): SkillSource[] {
    return [bucketSkills(this.env.BUCKET, { refreshIntervalMs: 0 })]
  }

  /** Sync skills with the bucket now; `true` when the catalog changed. */
  async syncSkillsForTest(): Promise<boolean> {
    await this.harness.pi()
    return this.skills.sync(this.registry)
  }

  /** Submit and wait for pi's answer: its status, text and the transcript entry kinds. */
  async promptForTest(prompt: string): Promise<{ status: string; text?: string; kinds: string[] }> {
    const result = await this.harness.prompt(prompt)
    return { status: result.status, text: result.text, kinds: result.messages.map((entry) => entry.kind) }
  }
}

/** The application's PiRegistry, with a way to reach a session's Agent directly. */
export class PiRegistry extends AppPiRegistry {
  /** The physical Agent name behind a catalog entry, or null once it is gone. */
  async sessionAgentNameForTest(sessionId: string): Promise<string | null> {
    const stub = await this.sessions.get(sessionId)
    if (!stub) return null
    const name = stub.id.name
    if (!name) throw new Error(`Session ${sessionId} has no Agent name`)
    return name
  }
}

export default {
  fetch() {
    return new Response('Not found', { status: 404 })
  },
}
