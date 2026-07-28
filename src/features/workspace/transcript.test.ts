import { describe, expect, it } from 'vitest'
import { messageText, reduceStreamEvent, transcriptEntries, type TranscriptState } from './transcript'

describe('messageText', () => {
  it('reads string messages', () => {
    expect(messageText({ content: 'hello' })).toBe('hello')
  })

  it('joins text blocks and ignores tool calls', () => {
    expect(messageText({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'toolCall', name: 'read' },
        { type: 'text', text: 'world' },
      ],
    })).toBe('hello world')
  })

  it('handles malformed messages', () => {
    expect(messageText(null)).toBe('')
    expect(messageText({ content: [{ type: 'text' }] })).toBe('')
  })
})

describe('transcriptEntries', () => {
  it('keeps reasoning, tool calls, and final responses distinct', () => {
    expect(transcriptEntries([
      { role: 'user', content: 'Create a file' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'I should write it.' },
        { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: '/hello.ts' } },
      ] },
      { role: 'toolResult', toolCallId: 'call-1', isError: false },
      { role: 'assistant', content: [{ type: 'text', text: 'Created it.' }] },
    ])).toEqual([
      { id: 'stored-0', type: 'message', role: 'user', text: 'Create a file' },
      { id: 'stored-1-0', type: 'reasoning', text: 'I should write it.', status: 'complete' },
      { id: 'stored-1-1', type: 'tool', callId: 'call-1', name: 'write', args: { path: '/hello.ts' }, status: 'complete' },
      { id: 'stored-3-0', type: 'message', role: 'assistant', text: 'Created it.' },
    ])
  })

  it('marks failed tool calls', () => {
    expect(transcriptEntries([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'call-1', isError: true },
    ])[0]).toMatchObject({ type: 'tool', status: 'error' })
  })
})

describe('reduceStreamEvent', () => {
  const empty: TranscriptState = { entries: [], activeReasoningId: '', activeTextId: '' }

  it('creates IDs without detaching randomUUID from crypto', () => {
    const started = reduceStreamEvent(empty, { type: 'text_start' })

    expect(started.activeTextId).toBeTruthy()
  })

  it('accumulates streamed text in one assistant message', () => {
    const started = reduceStreamEvent(empty, { type: 'text_start' }, () => 'message-1')
    const first = reduceStreamEvent(started, { type: 'text_delta', delta: 'Hello ' })
    const second = reduceStreamEvent(first, { type: 'text_delta', delta: 'world' })

    expect(second.entries).toEqual([
      { id: 'message-1', type: 'message', role: 'assistant', text: 'Hello world' },
    ])
  })

  it('tracks reasoning and tool completion independently', () => {
    const reasoning = reduceStreamEvent(empty, { type: 'thinking_start' }, () => 'reasoning-1')
    const tool = reduceStreamEvent(reasoning, {
      type: 'tool_execution_start',
      callId: 'call-1',
      name: 'write',
      args: { path: '/hello.ts' },
    })
    const completed = reduceStreamEvent(tool, {
      type: 'tool_execution_end',
      callId: 'call-1',
      name: 'write',
      isError: false,
    })

    expect(completed.entries).toMatchObject([
      { id: 'reasoning-1', type: 'reasoning', status: 'running' },
      { id: 'tool-call-1', type: 'tool', status: 'complete' },
    ])
  })
})
