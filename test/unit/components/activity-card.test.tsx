import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityCard } from '~/components/activity-card'

describe('ActivityCard', () => {
  it('shows a tool result screenshot that opens full size', async () => {
    render(<ActivityCard entry={{
      id: 't1', type: 'tool', callId: 'c1', name: 'browser', args: { task: 'look at it' },
      result: 'Screenshot of the page', images: [{ alt: 'Screenshot of the page', src: 'data:image/png;base64,QUJD' }], status: 'complete',
    }} />)
    fireEvent.click(screen.getByRole('button', { name: /Browser/ }))
    const image = await screen.findByRole('img', { name: 'Screenshot of the page' })
    expect(image.closest('a')?.getAttribute('href')).toBe('data:image/png;base64,QUJD')
  })
})
