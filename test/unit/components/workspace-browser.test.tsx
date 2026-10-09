import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBrowser } from '~/components/workspace-browser'
import type { WorkspaceFile } from '~/contract'

const now = '2026-07-28T12:00:00.000Z'
const file = (path: string): WorkspaceFile => ({ path, size: 10, mtime: now })

function browser(selectedPath: string, onSelectPath: (path: string) => void) {
  return (
    <WorkspaceBrowser
      canDownload={Boolean(selectedPath)}
      fileContent="file body"
      fileError=""
      files={[file('/workspace/a.ts'), file('/workspace/notes.md')]}
      filesError=""
      filesLoading={false}
      onDownload={() => {}}
      onRefresh={() => {}}
      onSelectPath={onSelectPath}
      selectedPath={selectedPath}
    />
  )
}

describe('WorkspaceBrowser', () => {
  afterEach(cleanup)

  it('opens a tapped file full-screen on a phone, and goes back to the list', () => {
    const onSelectPath = vi.fn()
    render(browser('', onSelectPath))

    // Nothing is drilled into yet, so there is no way back.
    expect(screen.queryByRole('button', { name: 'Back to files' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))
    expect(onSelectPath).toHaveBeenCalledWith('/workspace/a.ts')

    // The back button only exists with a file open; it closes the preview rather than picking another one.
    cleanup()
    render(browser('/workspace/a.ts', onSelectPath))
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(onSelectPath).toHaveBeenCalledWith('')
  })

  it('marks the open file and offers its actions', () => {
    render(browser('/workspace/notes.md', () => {}))
    expect((screen.getByRole('button', { name: /notes\.md/ }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled).toBe(false)
    // A Markdown file offers its rendered/source switch.
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeTruthy()
  })
})
