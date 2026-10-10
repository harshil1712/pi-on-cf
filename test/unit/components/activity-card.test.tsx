import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityCard } from '~/components/activity-card'

describe('ActivityCard', () => {
  it('shows a tool result screenshot with the card collapsed, without a link', () => {
    render(<ActivityCard entry={{
      id: 't1', type: 'tool', callId: 'c1', name: 'browser', args: { task: 'look at it' },
      result: 'Screenshot of the page', images: [{ alt: 'Screenshot', src: 'data:image/png;base64,QUJD' }], status: 'complete',
    }} />)
    expect(screen.getByRole('button', { name: /Browser/ }).getAttribute('aria-expanded')).toBe('false')
    const image = screen.getByRole('img', { name: 'Screenshot' })
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    // Browsers refuse to open a data: URL in a new tab, so there is no link to one.
    expect(image.closest('a')).toBeNull()
  })
})
