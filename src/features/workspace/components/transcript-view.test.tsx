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
})
