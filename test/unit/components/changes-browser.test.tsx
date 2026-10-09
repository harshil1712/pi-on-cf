import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChangesBrowser } from '~/components/changes-browser'
import type { SessionTask } from '~/contract'

const task: SessionTask = { repo: 'octo/demo', baseBranch: 'main', baseCommit: 'abc', branch: 'pi/123', dir: '/workspace/demo' }
const change = { path: 'src/index.ts', status: 'M' as const, insertions: 3, deletions: 1 }

function changes(selectedPath: string, onSelectPath: (path: string) => void, list = [change]) {
  return (
    <ChangesBrowser
      changes={list}
      diff="+changed src/index.ts\n"
      diffError=""
      error=""
      loading={false}
      onRefresh={() => {}}
      onSelectPath={onSelectPath}
      selectedPath={selectedPath}
      task={task}
    />
  )
}

describe('ChangesBrowser', () => {
  afterEach(cleanup)

  it('opens a tapped change full-screen on a phone, and goes back to the list', () => {
    const onSelectPath = vi.fn()
    render(changes('', onSelectPath))

    expect(screen.queryByRole('button', { name: 'Back to changed files' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /src\/index\.ts/ }))
    expect(onSelectPath).toHaveBeenCalledWith('src/index.ts')

    cleanup()
    render(changes('src/index.ts', onSelectPath))
    // The drilled-in header names the file whose diff is open.
    expect(screen.getAllByTitle('src/index.ts').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Back to changed files' }))
    expect(onSelectPath).toHaveBeenCalledWith('')
  })

  it('drops back to the list when the open change disappears', () => {
    const { rerender } = render(changes('', () => {}))
    fireEvent.click(screen.getByRole('button', { name: /src\/index\.ts/ }))
    rerender(changes('src/index.ts', () => {}))
    expect(screen.getByLabelText('Changed files').className).toContain('hidden')

    // The change was reverted: the list empties and the selection clears, so the phone must show the list again.
    rerender(changes('', () => {}, []))
    expect(screen.getByLabelText('Changed files').className).not.toContain('hidden')
  })
})
