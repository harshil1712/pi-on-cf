import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { PiStreamEvent } from '../shared/pi-contract'

export function toPiStreamEvent(event: AgentHarnessEvent | { type: 'done' }): PiStreamEvent | undefined {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_start') {
    return { type: 'text_start' }
  }
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    return { type: 'text_delta', delta: event.assistantMessageEvent.delta }
  }
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_end') {
    return { type: 'text_end' }
  }
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_start') {
    return { type: 'thinking_start' }
  }
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') {
    return { type: 'thinking_delta', delta: event.assistantMessageEvent.delta }
  }
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_end') {
    return { type: 'thinking_end' }
  }
  if (event.type === 'tool_execution_start') {
    return { type: event.type, callId: event.toolCallId, name: event.toolName, args: event.args }
  }
  if (event.type === 'tool_execution_end') {
    return { type: event.type, callId: event.toolCallId, name: event.toolName, isError: event.isError }
  }
  if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage) {
    return { type: 'error', error: event.message.errorMessage }
  }
  if (event.type === 'done') return event
}
