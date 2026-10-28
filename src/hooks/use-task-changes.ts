import { useState } from 'react'
import type { PiSessionContract, SessionTask, TaskChange } from '~/contract'
import { useRemote } from './use-remote'

type ChangesStub = Pick<PiSessionContract, 'listChanges' | 'readChange'>

const NO_CHANGES: TaskChange[] = []

/**
 * The files a task changed since its base commit, and the diff of the one
 * selected. Reloads whenever `version` moves, as the file list does.
 */
export function useTaskChanges(stub: ChangesStub, task: SessionTask | null, version: number) {
  const [chosenPath, setSelectedPath] = useState('')
  const list = useRemote(task ? `changes:${version}` : null, () => stub.listChanges())
  const changes = task ? list.value ?? NO_CHANGES : NO_CHANGES
  // The chosen file while it is still changed, else the first.
  const selectedPath = changes.some((change) => change.path === chosenPath) ? chosenPath : (changes[0]?.path ?? '')
  // Each new list may hold new contents for the same path.
  const diff = useRemote(selectedPath ? `${list.answered}:${selectedPath}` : null, () => stub.readChange(selectedPath))

  return {
    changes,
    diff: diff.current ?? '',
    diffError: diff.error,
    error: list.error,
    loading: list.loading,
    refresh: list.reload,
    selectedPath,
    setSelectedPath,
  }
}
