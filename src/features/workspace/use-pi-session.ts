import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, UIEvent } from 'react'
import { useAgent } from 'agents/react'
import type { AgentEvent } from '@earendil-works/pi-durable'
import {
  PI_AGENT_NAME,
  PI_AGENT_PREFIX,
  PI_REGISTRY_INSTANCE,
  PI_REGISTRY_NAME,
  type PiEventsMessage,
  type PiRegistryContract,
  type PiSessionContract,
  type SessionSummary,
  type WorkspaceFile,
} from '../../shared/pi-contract'
import { EMPTY_VIEW, reducePiEvents, transcriptEntries, type PiView } from './transcript'

function isPiEvents(value: unknown): value is PiEventsMessage {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'pi:events')
}

/**
 * The Agents SDK reports a failed session startup with one `{ error: stack }`
 * frame, then closes with 1011 and the client retries. Returns the stack's
 * first line, the error message.
 */
function setupError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' ? error.split('\n')[0] : undefined
}

const NORMAL_CLOSURE = 1000

export function usePiSession(sessionId: string) {
  const [view, setView] = useState<PiView>(EMPTY_VIEW)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState('')
  // Connection trouble, cleared as soon as pi events flow again.
  const [connectionError, setConnectionError] = useState('')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [fileContentPath, setFileContentPath] = useState('')
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError] = useState('')
  const [fileError, setFileError] = useState('')
  const [filesVersion, setFilesVersion] = useState(0)
  const [mobileView, setMobileView] = useState<'chat' | 'files'>('chat')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const filesRequestRef = useRef(0)
  const pendingEventsRef = useRef<AgentEvent[]>([])
  const frameRef = useRef<number | null>(null)
  const shouldAutoScrollRef = useRef(true)

  const flushEvents = useCallback(() => {
    frameRef.current = null
    const events = pendingEventsRef.current.splice(0)
    if (events.length === 0) return
    setView((current) => reducePiEvents(current, events))
    setIsReady(true)
    // A finished tool or run may have changed the workspace.
    if (events.some((event) => event.type === 'tool_execution_end' || event.type === 'run_end')) {
      setFilesVersion((version) => version + 1)
    }
  }, [])

  const agent = useAgent<PiSessionContract, unknown>({
    agent: PI_AGENT_NAME,
    name: sessionId,
    prefix: PI_AGENT_PREFIX,
    onMessage: (message) => {
      if (typeof message.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      const failure = setupError(parsed)
      if (failure) {
        setConnectionError(`The session could not start: ${failure}. Retrying…`)
        return
      }
      if (!isPiEvents(parsed)) return
      setConnectionError('')
      // A snapshot replaces everything before it, so drop queued deltas.
      if (parsed.events[0]?.type === 'snapshot') pendingEventsRef.current = []
      pendingEventsRef.current.push(...parsed.events)
      frameRef.current ??= requestAnimationFrame(flushEvents)
    },
    onClose: (event) => {
      if (event.code === NORMAL_CLOSURE) return
      // Keep a startup failure's message; it says more than this one.
      setConnectionError((current) => current || 'Connection to the session lost. Reconnecting…')
    },
    onConnectionError: (failure) => setError(failure.message),
  })
  const registry = useAgent<PiRegistryContract, unknown>({
    agent: PI_REGISTRY_NAME,
    name: PI_REGISTRY_INSTANCE,
    prefix: PI_AGENT_PREFIX,
  })

  const refreshFiles = useCallback(async () => {
    const request = ++filesRequestRef.current
    setFilesLoading(true)
    setFilesError('')
    try {
      const nextFiles = await agent.stub.listFiles()
      if (request !== filesRequestRef.current) return
      setFiles(nextFiles)
      setSelectedPath((current) => nextFiles.some((file) => file.path === current) ? current : (nextFiles[0]?.path ?? ''))
    } catch (caught) {
      if (request === filesRequestRef.current) setFilesError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === filesRequestRef.current) setFilesLoading(false)
    }
  }, [agent.stub])

  useEffect(() => {
    void refreshFiles()
  }, [refreshFiles, filesVersion])

  useEffect(() => {
    let ignore = false
    registry.stub.getSession(sessionId).then((session) => {
      if (!ignore) setSummary(session)
    }).catch((caught) => {
      if (!ignore) setError(caught instanceof Error ? caught.message : String(caught))
    })
    return () => { ignore = true }
  }, [registry.stub, sessionId])

  useEffect(() => () => {
    filesRequestRef.current += 1
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    pendingEventsRef.current = []
  }, [])

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

  const transcript = useMemo(() => transcriptEntries(view), [view])
  const isRunning = view.running || isSubmitting

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: isRunning ? 'auto' : 'smooth' })
  }, [transcript.entries, isRunning])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || isSubmitting || !isReady) return
    setInput('')
    setError('')
    setIsSubmitting(true)
    shouldAutoScrollRef.current = true
    try {
      // Durable once this resolves; the answer streams in as pi events. While
      // pi is running, the prompt steers it: pi places it after the current
      // tool round.
      await (view.running ? agent.stub.steer(prompt) : agent.stub.submit(prompt))
    } catch (caught) {
      setInput(prompt)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function rename() {
    const next = window.prompt('Session name', summary?.name ?? '')
    if (next === null) return
    try {
      setSummary(await registry.stub.renameSession(sessionId, next.trim() || undefined))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
    canDownload: Boolean(selectedPath && selectedPath === fileContentPath && !fileError),
    downloadSelectedFile,
    entries: transcript.entries,
    error: error || connectionError || view.error,
    fileContent,
    fileError,
    files,
    filesError,
    filesLoading,
    handleTranscriptScroll,
    input,
    isReady,
    isRunning,
    mobileView,
    queued: view.queued,
    refreshFiles,
    rename,
    selectedPath,
    setInput,
    setMobileView,
    setSelectedPath,
    submit,
    summary,
    transcriptRef,
  }
}
