import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptView } from './transcript-view'

const baseProps = {
  activeTextId: '',
  isRunning: false,
  onScroll: vi.fn(),
  onTryOperation: vi.fn(),
  transcriptRef: { current: null },
}

describe('TranscriptView', () => {
  afterEach(cleanup)

  it('renders assistant Markdown while keeping user messages literal', () => {
    render(
      <TranscriptView
        {...baseProps}
        entries={[
          { id: 'user', type: 'message', role: 'user', text: '**literal**' },
          { id: 'assistant', type: 'message', role: 'assistant', text: '**formatted**' },
        ]}
      />,
    )

    expect(screen.getByText('**literal**').tagName).toBe('DIV')
    expect(screen.getByText('formatted')).toBeTruthy()
    expect(screen.queryByText('**formatted**')).toBeNull()
  })

  it('provides log semantics and announces a completed assistant response', () => {
    render(
      <TranscriptView
        {...baseProps}
        entries={[{ id: 'assistant', type: 'message', role: 'assistant', text: 'Work complete.' }]}
      />,
    )

    expect(screen.getByRole('log').getAttribute('aria-live')).toBe('off')
    expect(screen.getByText('Pi replied: Work complete.').getAttribute('aria-live')).toBe('polite')
  })

  it('labels a compaction checkpoint as a summary rather than reasoning', () => {
    render(
      <TranscriptView
        {...baseProps}
        entries={[{ id: 'summary', type: 'summary', kind: 'compaction', text: 'Earlier work', status: 'complete' }]}
      />,
    )

    expect(screen.getByText('COMPACTION SUMMARY')).toBeTruthy()
    expect(screen.queryByText('REASONING')).toBeNull()
  })
})
