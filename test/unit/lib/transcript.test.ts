import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, messageText, reducePiEvents, transcriptEntries } from '~/lib/transcript'

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content, api: 'faux', provider: 'faux', model: 'faux', usage, stopReason: 'stop', timestamp: 0 }
}

let nextId = 1
function entry(kind: string, message?: Message, extra: Partial<EntryRecord> = {}): EntryRecord {
  return { id: nextId++, conversationId: 1, kind, ...(message ? { model: [message] } : {}), ...extra } as EntryRecord
}

const user = (text: string) => entry('pi.user', { role: 'user', content: text, timestamp: 0 })

function snapshot(entries: EntryRecord[], extra: Partial<Extract<AgentEvent, { type: 'snapshot' }>> = {}): AgentEvent {
  return { type: 'snapshot', entries, tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...extra } as AgentEvent
}

describe('messageText', () => {
  it('reads string and block content', () => {
    expect(messageText({ content: 'hello' })).toBe('hello')
    expect(messageText({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] })).toBe('hello world')
    expect(messageText(undefined)).toBe('')
  })
})

describe('pi event reducer', () => {
  it('keeps a screenshot a tool returns as an image, apart from its text', () => {
    const view = reducePiEvents(EMPTY_VIEW, [snapshot([
      user('Look at a page'),
      entry('pi.assistant', assistant([{ type: 'toolCall', id: 'call-9', name: 'browser', arguments: { task: 'look' } }])),
      entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-9', toolName: 'browser', content: [
        { type: 'text', text: 'Screenshot of example.com' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ], isError: false, timestamp: 0 }),
    ])])
    const tool = transcriptEntries(view).entries.find((row) => row.type === 'tool' && row.name === 'browser')
    expect(tool && 'result' in tool ? tool.result : '').toBe('Screenshot of example.com')
    expect(tool && 'images' in tool ? tool.images : []).toEqual([{ alt: 'Screenshot of example.com', src: 'data:image/png;base64,QUJD' }])
  })

  it('passes a data URL through and falls back to a generic alt', () => {
    const view = reducePiEvents(EMPTY_VIEW, [snapshot([
      entry('pi.assistant', assistant([{ type: 'toolCall', id: 'call-8', name: 'browser', arguments: {} }])),
      entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-8', toolName: 'browser', content: [
        { type: 'image', data: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' },
      ], isError: false, timestamp: 0 }),
    ])])
    const tool = transcriptEntries(view).entries.find((row) => row.type === 'tool' && row.name === 'browser')
    expect(tool && 'images' in tool ? tool.images : []).toEqual([{ alt: 'Screenshot', src: 'data:image/jpeg;base64,AAAA' }])
  })

  it('projects a snapshot into reasoning, tool calls, and responses', () => {
    const view = reducePiEvents(EMPTY_VIEW, [snapshot([
      user('Create a file'),
      entry('pi.system', { role: 'system', content: 'prompt', timestamp: 0 } as unknown as Message),
      entry('pi.assistant', assistant([
        { type: 'thinking', thinking: 'I should write it.' },
        { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: '/workspace/a.ts' } },
      ])),
      entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-1', toolName: 'write', content: [{ type: 'text', text: 'wrote' }], isError: false, timestamp: 0 }),
      entry('pi.assistant', assistant([{ type: 'text', text: 'Done.' }])),
    ])])

    expect(transcriptEntries(view).entries.map((row) => ({ type: row.type, ...('status' in row ? { status: row.status } : {}) }))).toEqual([
      { type: 'message' },
      { type: 'reasoning', status: 'complete' },
      { type: 'tool', status: 'complete' },
      { type: 'message' },
    ])
    expect(transcriptEntries(view).entries[2]).toMatchObject({ name: 'write', result: 'wrote', args: { path: '/workspace/a.ts' } })
  })

  it('streams the live assistant message and settles it on message_end', () => {
    const final = entry('pi.assistant', assistant([{ type: 'text', text: 'Hello there' }]))
    let view = reducePiEvents(EMPTY_VIEW, [snapshot([user('hi')]), { type: 'run_start', inputs: [] } as AgentEvent])
    view = reducePiEvents(view, [
      { type: 'message_start', message: assistant([]) },
      { type: 'message_update', usage, changes: [
        { type: 'text_start', contentIndex: 0, block: { type: 'text', text: '' } },
        { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
      ] },
    ] as AgentEvent[])

    const streaming = transcriptEntries(view)
    expect(view.running).toBe(true)
    expect(streaming.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'Hello' })
    expect(streaming.activeTextId).toBe(streaming.entries.at(-1)?.id)

    view = reducePiEvents(view, [
      { type: 'message_update', usage, changes: [{ type: 'text_delta', contentIndex: 0, delta: ' there' }] },
      { type: 'message_end', entry: final },
      { type: 'run_end', inputs: [] },
    ] as AgentEvent[])

    expect(view.live).toBeNull()
    expect(view.running).toBe(false)
    expect(transcriptEntries(view)).toEqual({
      activeTextId: '',
      entries: [
        expect.objectContaining({ role: 'user', text: 'hi' }),
        expect.objectContaining({ role: 'assistant', text: 'Hello there' }),
      ],
    })
  })

  it('shows running tool output until the result arrives', () => {
    const call = entry('pi.assistant', assistant([{ type: 'toolCall', id: 'call-2', name: 'exec', arguments: { command: 'ls' } }]))
    let view = reducePiEvents(EMPTY_VIEW, [snapshot([user('list'), call], { run: { inputs: [] } })])
    view = reducePiEvents(view, [
      { type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'exec', args: { command: 'ls' } },
      { type: 'tool_execution_update', toolCallId: 'call-2', toolName: 'exec', output: { append: 'a.ts\n' } },
    ] as AgentEvent[])

    expect(transcriptEntries(view).entries.at(-1)).toMatchObject({ type: 'tool', status: 'running', result: 'a.ts\n' })

    view = reducePiEvents(view, [{
      type: 'tool_execution_end',
      toolCallId: 'call-2',
      toolName: 'exec',
      entry: entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-2', toolName: 'exec', content: [{ type: 'text', text: 'a.ts' }], isError: true, timestamp: 0 }),
    }] as AgentEvent[])

    expect(view.tools).toEqual({})
    expect(transcriptEntries(view).entries.at(-1)).toMatchObject({ type: 'tool', status: 'error', result: 'a.ts' })
  })

  it('starts a new context at a compaction head and shows its summary first', () => {
    const old = user('old')
    const kept = user('kept')
    const compaction = entry('pi.compaction', { role: 'user', content: 'Summary of earlier work', timestamp: 0 }, { head: kept.id })
    const view = reducePiEvents(EMPTY_VIEW, [snapshot([old, kept]), { type: 'entry_appended', entry: compaction }])

    expect(transcriptEntries(view).entries).toEqual([
      expect.objectContaining({ type: 'summary', kind: 'compaction', text: 'Summary of earlier work' }),
      expect.objectContaining({ type: 'message', text: 'kept' }),
    ])
  })

  it('reports unanswered submissions but not aborts', () => {
    const failed = reducePiEvents(EMPTY_VIEW, [{ type: 'submission', record: { status: 'unanswered', reason: 'no_model' } } as unknown as AgentEvent])
    const aborted = reducePiEvents(EMPTY_VIEW, [{ type: 'submission', record: { status: 'unanswered', reason: 'aborted' } } as unknown as AgentEvent])

    expect(failed.error).toMatch(/no_model/)
    expect(aborted.error).toBe('')
  })
})
