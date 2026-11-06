import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, messageText, reducePiView, transcriptEntries } from '~/lib/transcript'
import { assistant, entry as entryWithId, snapshot, unanswered } from '../pi-views'

let nextId = 1

function entry(kind: string, message?: Message, extra: Partial<EntryRecord> = {}): EntryRecord {
  return { ...entryWithId(nextId++, kind, message), ...extra }
}

const user = (text: string) => entry('pi.user', { role: 'user', content: text, timestamp: 0 })

describe('messageText', () => {
  it('reads string and block content', () => {
    expect(messageText({ content: 'hello' })).toBe('hello')
    expect(messageText({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] })).toBe('hello world')
    expect(messageText(undefined)).toBe('')
  })
})

describe('conversation view projection', () => {
  it('keeps a screenshot a tool returns as an image, apart from its text', () => {
    const view = reducePiView(EMPTY_VIEW, snapshot([
      user('Look at a page'),
      entry('pi.assistant', assistant([{ type: 'toolCall', id: 'call-9', name: 'browser', arguments: { task: 'look' } }])),
      entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-9', toolName: 'browser', content: [
        { type: 'text', text: 'Screenshot of example.com' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ], isError: false, timestamp: 0 }),
    ]))

    const tool = transcriptEntries(view).entries.find((row) => row.type === 'tool' && row.name === 'browser')
    expect(tool && 'result' in tool ? tool.result : '').toBe('Screenshot of example.com')
    expect(tool && 'images' in tool ? tool.images : []).toEqual([{ alt: 'Screenshot', src: 'data:image/png;base64,QUJD' }])
  })

  it('passes a data URL through', () => {
    const view = reducePiView(EMPTY_VIEW, snapshot([
      entry('pi.assistant', assistant([{ type: 'toolCall', id: 'call-8', name: 'browser', arguments: {} }])),
      entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-8', toolName: 'browser', content: [
        { type: 'image', data: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' },
      ], isError: false, timestamp: 0 }),
    ]))

    const tool = transcriptEntries(view).entries.find((row) => row.type === 'tool' && row.name === 'browser')
    expect(tool && 'images' in tool ? tool.images : []).toEqual([{ alt: 'Screenshot', src: 'data:image/jpeg;base64,AAAA' }])
  })

  it('projects reasoning, tool calls, and responses', () => {
    const view = reducePiView(EMPTY_VIEW, snapshot([
      user('Create a file'),
      // Bookkeeping the transcript does not show.
      entry('pi.system'),
      entry('pi.assistant', assistant([
        { type: 'thinking', thinking: 'I should write it.' },
        { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: '/workspace/a.ts' } },
      ])),
      entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-1', toolName: 'write', content: [{ type: 'text', text: 'wrote' }], isError: false, timestamp: 0 }),
      entry('pi.assistant', assistant([{ type: 'text', text: 'Done.' }])),
    ]))

    expect(transcriptEntries(view).entries.map((row) => ('status' in row ? { type: row.type, status: row.status } : { type: row.type }))).toEqual([
      { type: 'message' },
      { type: 'reasoning', status: 'complete' },
      { type: 'tool', status: 'complete' },
      { type: 'message' },
    ])
    expect(transcriptEntries(view).entries[2]).toMatchObject({ name: 'write', result: 'wrote', args: { path: '/workspace/a.ts' } })
  })

  it('renders the live assistant message, then its committed entry', () => {
    const prompt = user('hi')
    const final = entry('pi.assistant', assistant([{ type: 'text', text: 'Hello there' }]))

    let view = reducePiView(EMPTY_VIEW, snapshot([prompt], {
      run: {},
      generation: { attempt: 1, message: assistant([{ type: 'text', text: 'Hello' }]) },
    }))

    const streaming = transcriptEntries(view)

    expect(view.running).toBe(true)
    expect(streaming.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'Hello' })
    expect(streaming.activeTextId).toBe(streaming.entries.at(-1)?.id)

    view = reducePiView(view, snapshot([prompt], {
      run: {},
      generation: { attempt: 1, message: assistant([{ type: 'text', text: 'Hello there' }]) },
    }))
    expect(transcriptEntries(view).entries.at(-1)).toMatchObject({ text: 'Hello there' })

    view = reducePiView(view, snapshot([prompt, final]))

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
    const prompt = user('list')
    const call = entry('pi.assistant', assistant([{ type: 'toolCall', id: 'call-2', name: 'exec', arguments: { command: 'ls' } }]))

    let view = reducePiView(EMPTY_VIEW, snapshot([prompt, call], {
      run: {},
      tools: [{ callId: 'call-2', name: 'exec', status: 'running', output: 'a.ts\n' }],
    }))

    expect(transcriptEntries(view).entries.at(-1)).toMatchObject({ type: 'tool', status: 'running', result: 'a.ts\n' })
    const result = entry('pi.tool-result', { role: 'toolResult', toolCallId: 'call-2', toolName: 'exec', content: [{ type: 'text', text: 'a.ts' }], isError: true, timestamp: 0 })

    view = reducePiView(view, snapshot([prompt, call, result]))

    expect(view.tools).toEqual({})
    expect(transcriptEntries(view).entries.at(-1)).toMatchObject({ type: 'tool', status: 'error', result: 'a.ts' })
  })

  it('keeps compaction history in entry order', () => {
    const old = user('old')
    const kept = user('kept')
    const compaction = entry('pi.compaction', { role: 'user', content: 'Summary of earlier work', timestamp: 0 }, { head: kept.id })
    const view = reducePiView(EMPTY_VIEW, snapshot([old, kept, compaction]))

    expect(transcriptEntries(view).entries).toEqual([
      expect.objectContaining({ type: 'message', text: 'old' }),
      expect.objectContaining({ type: 'message', text: 'kept' }),
      expect.objectContaining({ type: 'summary', kind: 'compaction', text: 'Summary of earlier work' }),
    ])
  })

  it('reports run failures but not aborts', () => {
    const failed = reducePiView(EMPTY_VIEW, unanswered('no_model'))
    const aborted = reducePiView(EMPTY_VIEW, unanswered('aborted'))

    expect(failed.error).toMatch(/no_model/)
    expect(aborted.error).toBe('')
  })
})
