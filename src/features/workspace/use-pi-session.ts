import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, UIEvent } from 'react'
import { useAgent } from 'agents/react'
import {
  PI_AGENT_NAME,
  PI_AGENT_PREFIX,
  PI_SESSION_NAME,
  type PiSessionContract,
  type PiStreamEvent,
  type WorkspaceFile,
} from '../../shared/pi-contract'
import { reduceStreamEvent, transcriptEntries, type TranscriptState } from './transcript'

const emptyTranscript: TranscriptState = { entries: [], activeReasoningId: '', activeTextId: '' }

export function usePiSession() {
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript)
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [fileContentPath, setFileContentPath] = useState('')
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError] = useState('')
  const [fileError, setFileError] = useState('')
  const [mobileView, setMobileView] = useState<'chat' | 'files'>('chat')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const filesRequestRef = useRef(0)
  const shouldAutoScrollRef = useRef(true)
  const agent = useAgent<PiSessionContract, unknown>({
    agent: PI_AGENT_NAME,
    name: PI_SESSION_NAME,
    prefix: PI_AGENT_PREFIX,
    onConnectionError: (connectionError) => setError(connectionError.message),
  })

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
      if (request === filesRequestRef.current) {
        setFilesError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (request === filesRequestRef.current) setFilesLoading(false)
    }
  }, [agent.stub])

  useEffect(() => {
    let ignore = false
    agent.stub.loadTranscript()
      .then((stored) => {
        if (!ignore) setTranscript({ ...emptyTranscript, entries: transcriptEntries(stored) })
      })
      .catch(() => {
        if (!ignore) setError('Could not restore the workspace transcript.')
      })
      .finally(() => {
        if (!ignore) setIsReady(true)
      })
    return () => {
      ignore = true
    }
  }, [agent.stub])

  useEffect(() => {
    void refreshFiles()
    return () => {
      filesRequestRef.current += 1
    }
  }, [refreshFiles])

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
    agent.stub.readWorkspaceFile(selectedPath)
      .then((file) => {
        if (!ignore) {
          setFileContent(file.content)
          setFileContentPath(file.path)
        }
      })
      .catch((caught) => {
        if (!ignore) setFileError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      ignore = true
    }
  }, [agent.stub, selectedFileMtime, selectedPath])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: isRunning ? 'auto' : 'smooth' })
  }, [transcript.entries, isRunning])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || isRunning || isResetting || !isReady) return

    setInput('')
    setError('')
    setIsRunning(true)
    setTranscript((current) => ({
      ...current,
      entries: [...current.entries, { id: crypto.randomUUID(), type: 'message', role: 'user', text: prompt }],
    }))

    try {
      await agent.call('prompt', [prompt], {
        stream: {
          onChunk: (chunk) => {
            const update = chunk as PiStreamEvent
            if (update.type === 'error') {
              setError(update.error || 'Pi stopped unexpectedly.')
            } else {
              setTranscript((current) => reduceStreamEvent(current, update))
            }
          },
          onError: (streamError) => setError(streamError),
        },
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsRunning(false)
      void refreshFiles()
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

  async function reset() {
    if (isRunning || isResetting) return
    setIsResetting(true)
    try {
      await agent.stub.clearTranscript()
      setTranscript(emptyTranscript)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsResetting(false)
    }
  }

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }

  return {
    activeTextId: transcript.activeTextId,
    downloadSelectedFile,
    canDownload: Boolean(selectedPath && selectedPath === fileContentPath && !fileError),
    entries: transcript.entries,
    error,
    fileContent,
    fileError,
    files,
    filesError,
    filesLoading,
    handleTranscriptScroll,
    input,
    isReady,
    isResetting,
    isRunning,
    mobileView,
    refreshFiles,
    reset,
    selectedPath,
    sessionId: PI_SESSION_NAME,
    setInput,
    setMobileView,
    setSelectedPath,
    submit,
    transcriptRef,
  }
}
