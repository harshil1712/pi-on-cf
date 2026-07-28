import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, UIEvent } from 'react'
import { useAgent } from 'agents/react'
import {
  PI_AGENT_NAME,
  PI_AGENT_PREFIX,
  PI_REGISTRY_INSTANCE,
  PI_REGISTRY_NAME,
  type PiRegistryContract,
  type PiSessionContract,
  type PiStreamEvent,
  type SessionBranch,
  type SessionOverview,
  type WorkspaceFile,
} from '../../shared/pi-contract'
import { reduceStreamEvent, transcriptEntries, type TranscriptState } from './transcript'

const emptyTranscript: TranscriptState = { entries: [], activeReasoningId: '', activeTextId: '' }

export function usePiSession(sessionId: string) {
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript)
  const [overview, setOverview] = useState<SessionOverview | null>(null)
  const [branch, setBranch] = useState<SessionBranch | null>(null)
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [pendingAction, setPendingAction] = useState('')
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [fileContentPath, setFileContentPath] = useState('')
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError] = useState('')
  const [fileError, setFileError] = useState('')
  const [mobileView, setMobileView] = useState<'chat' | 'files' | 'tree'>('chat')
  const [desktopPanel, setDesktopPanel] = useState<'files' | 'tree'>('files')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const filesRequestRef = useRef(0)
  const sessionRequestRef = useRef(0)
  const promptRequestRef = useRef(0)
  const actionRequestRef = useRef(0)
  const streamEventsRef = useRef<PiStreamEvent[]>([])
  const streamFrameRef = useRef<number | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const agent = useAgent<PiSessionContract, unknown>({
    agent: PI_AGENT_NAME,
    name: sessionId,
    prefix: PI_AGENT_PREFIX,
    onConnectionError: (connectionError) => setError(connectionError.message),
  })
  const registry = useAgent<PiRegistryContract, unknown>({
    agent: PI_REGISTRY_NAME,
    name: PI_REGISTRY_INSTANCE,
    prefix: PI_AGENT_PREFIX,
  })

  const refreshSession = useCallback(async () => {
    const request = ++sessionRequestRef.current
    try {
      const [nextOverview, nextBranch] = await Promise.all([agent.stub.getOverview(), agent.stub.getBranch()])
      if (request !== sessionRequestRef.current) return
      setOverview(nextOverview)
      setBranch(nextBranch)
      setTranscript({ ...emptyTranscript, entries: transcriptEntries(nextBranch.entries) })
      setIsReady(true)
    } catch (caught) {
      if (request === sessionRequestRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [agent.stub])

  const refreshFiles = useCallback(async () => {
    const request = ++filesRequestRef.current
    setFilesLoading(true)
    setFilesError('')
    try {
      const nextFiles = (await agent.stub.listFiles()).sort((a, b) => a.path.localeCompare(b.path))
      if (request !== filesRequestRef.current) return
      setFiles(nextFiles)
      setSelectedPath((current) => nextFiles.some((file) => file.path === current) ? current : (nextFiles[0]?.path ?? ''))
    } catch (caught) {
      if (request === filesRequestRef.current) setFilesError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === filesRequestRef.current) setFilesLoading(false)
    }
  }, [agent.stub])

  function flushStreamEvents() {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
    const events = streamEventsRef.current.splice(0)
    if (events.length > 0) {
      setTranscript((current) => events.reduce((next, event) => reduceStreamEvent(next, event), current))
    }
  }

  function enqueueStreamEvent(event: PiStreamEvent) {
    streamEventsRef.current.push(event)
    if (streamFrameRef.current !== null) return
    streamFrameRef.current = requestAnimationFrame(() => {
      streamFrameRef.current = null
      const events = streamEventsRef.current.splice(0)
      setTranscript((current) => events.reduce((next, update) => reduceStreamEvent(next, update), current))
    })
  }

  useEffect(() => {
    shouldAutoScrollRef.current = true
    setInput('')
    setIsRunning(false)
    setPendingAction('')
    setIsReady(false)
    setOverview(null)
    setBranch(null)
    setTranscript(emptyTranscript)
    setError('')
    setFiles([])
    setSelectedPath('')
    setFileContent('')
    setFileContentPath('')
    setFilesError('')
    setFileError('')
    setMobileView('chat')
    setDesktopPanel('files')
    void refreshSession()
    void refreshFiles()
    return () => {
      sessionRequestRef.current += 1
      filesRequestRef.current += 1
      promptRequestRef.current += 1
      actionRequestRef.current += 1
      if (streamFrameRef.current !== null) cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
      streamEventsRef.current = []
    }
  }, [refreshFiles, refreshSession, sessionId])

  const selectedFileMtime = files.find((file) => file.path === selectedPath)?.mtime
  useEffect(() => {
    if (!selectedPath) {
      setFileContent('')
      setFileContentPath('')
      setFileError('')
      return
    }
    let ignore = false
    setFileContent('')
    setFileContentPath('')
    setFileError('')
    agent.stub.readWorkspaceFile(selectedPath).then((file) => {
      if (!ignore && file.path === selectedPath) {
        setFileContent(file.content)
        setFileContentPath(file.path)
      }
    }).catch((caught) => {
      if (!ignore) setFileError(caught instanceof Error ? caught.message : String(caught))
    })
    return () => { ignore = true }
  }, [agent.stub, selectedFileMtime, selectedPath])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: isRunning ? 'auto' : 'smooth' })
  }, [transcript.entries, isRunning])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || isRunning || pendingAction || !isReady) return
    const request = ++promptRequestRef.current
    setInput('')
    setError('')
    setIsRunning(true)
    streamEventsRef.current = []
    setTranscript((current) => ({ ...current, entries: [...current.entries, { id: crypto.randomUUID(), type: 'message', role: 'user', text: prompt }] }))
    try {
      await agent.call('prompt', [prompt], {
        stream: {
          onChunk: (chunk) => {
            if (request !== promptRequestRef.current) return
            const update = chunk as PiStreamEvent
            if (update.type === 'error') setError(update.error || 'Pi stopped unexpectedly.')
            else enqueueStreamEvent(update)
          },
          onError: (streamError) => { if (request === promptRequestRef.current) setError(streamError) },
        },
      })
    } catch (caught) {
      if (request === promptRequestRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === promptRequestRef.current) {
        flushStreamEvents()
        setIsRunning(false)
        await Promise.all([refreshSession(), refreshFiles()])
      }
    }
  }

  async function runAction(key: string, operation: () => Promise<unknown>) {
    if (pendingAction || isRunning) return
    const request = ++actionRequestRef.current
    setPendingAction(key)
    setError('')
    try {
      await operation()
      if (request === actionRequestRef.current) await refreshSession()
    } catch (caught) {
      if (request === actionRequestRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === actionRequestRef.current) setPendingAction('')
    }
  }

  function downloadSelectedFile() {
    if (!selectedPath) return
    const url = URL.createObjectURL(new Blob([fileContent], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = selectedPath.split('/').pop() || 'workspace-file'
    link.click()
    URL.revokeObjectURL(url)
  }

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }

  return {
    abort: async () => { try { await agent.stub.abort() } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) } },
    activeTextId: transcript.activeTextId,
    branch,
    canDownload: Boolean(selectedPath && selectedPath === fileContentPath && !fileError),
    compact: (focus?: string) => runAction('compact', () => agent.stub.compact(focus)),
    desktopPanel,
    downloadSelectedFile,
    entries: transcript.entries,
    error,
    fileContent,
    fileError,
    files,
    filesError,
    filesLoading,
    fork: (entryId: string, name?: string) => registry.stub.forkSession({ sourceSessionId: sessionId, entryId, name }),
    handleTranscriptScroll,
    input,
    isReady,
    isRunning,
    mobileView,
    navigateTree: (entryId: string) => runAction('navigate', async () => {
      const result = await agent.stub.navigateTree(entryId)
      if (result.editorText) setInput(result.editorText)
    }),
    overview,
    pendingAction,
    refreshFiles,
    rename: (name: string) => runAction('rename', () => agent.stub.setSessionName(name)),
    selectedPath,
    setDesktopPanel,
    setEntryLabel: (entryId: string, label?: string) => runAction('label', () => agent.stub.setEntryLabel(entryId, label)),
    setInput,
    setMobileView,
    setSelectedPath,
    submit,
    transcriptRef,
  }
}
