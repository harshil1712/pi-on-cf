import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SubmitEvent, UIEvent } from 'react'
import type { AgentEvent } from '@earendil-works/pi-durable'
import {
  PI_AGENT_NAME,
  type ModelOption,
  type PiEventsMessage,
  type PiSessionContract,
  type PiSessionState,
  type SessionSummary,
  type SessionTask,
  sessionBasePath,
  type WorkspaceFile,
} from '~/contract'
import { useSessionRegistry } from './use-session-registry'
import { EMPTY_VIEW, reducePiEvents, transcriptEntries, type PiView } from '~/lib/transcript'
import { useRemote } from './use-remote'
import { useTaskChanges } from './use-task-changes'
import { useAgentConnection } from './use-agent-connection'
import { errorMessage } from '~/lib/error-message'
import { isJsonObject, isString, parseJson, type Json, type JsonObject } from '~/lib/json'

function isPiEvents(value: Json | undefined): value is PiEventsMessage & JsonObject {
  return isJsonObject(value) && value.type === 'pi:events'
}

/**
 * The Agents SDK reports a failed session startup with one `{ error: stack }`
 * frame, then closes with 1011 and the client retries. Returns the stack's
 * first line, the error message.
 */
function setupError(value: Json | undefined): string | undefined {
  if (!isJsonObject(value)) return undefined
  const { error } = value

  return isString(error) ? error.split('\n')[0] : undefined
}

const NORMAL_CLOSURE = 1000

const NO_FILES: WorkspaceFile[] = []

/**
 * Coalesces pi's event batches into one state update per animation frame,
 * so a fast stream renders once a frame, not once a commit. A snapshot
 * replaces everything before it, so it drops the batches still queued.
 */
class FrameBatcher {
  readonly #flush: (events: AgentEvent[]) => void
  #queued: AgentEvent[] = []
  #frame: number | null = null

  constructor(flush: (events: AgentEvent[]) => void) {
    this.#flush = flush
  }

  push(events: readonly AgentEvent[]): void {
    if (events[0]?.type === 'snapshot') this.#queued = []
    this.#queued.push(...events)
    this.#frame ??= requestAnimationFrame(() => {
      this.#frame = null
      const queued = this.#queued.splice(0)

      if (queued.length) this.#flush(queued)
    })
  }

  cancel(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame)
    this.#frame = null
    this.#queued = []
  }
}

export function usePiSession(sessionId: string) {
  const [view, setView] = useState<PiView>(EMPTY_VIEW)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [task, setTask] = useState<SessionTask | null>(null)
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState('')
  // Connection trouble, cleared as soon as pi events flow again.
  const [connectionError, setConnectionError] = useState('')
  const [chosenPath, setSelectedPath] = useState('')
  const [filesVersion, setFilesVersion] = useState(0)
  const [mobileView, setMobileView] = useState<'chat' | 'workspace'>('chat')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  const [batcher] = useState(() => new FrameBatcher((events) => {
    setView((current) => reducePiEvents(current, events))
    setIsReady(true)

    // A finished tool or run may have changed the workspace.
    if (events.some((event) => event.type === 'tool_execution_end' || event.type === 'run_end')) {
      setFilesVersion((version) => version + 1)
    }
  }))

  const useConnection = useAgentConnection()

  const agent = useConnection<PiSessionContract, PiSessionState>({
    // The registry routes the socket to the session's Agent.
    agent: PI_AGENT_NAME,
    basePath: sessionBasePath(sessionId),
    // The task, the pull request once the agent opens one, and the model.
    onStateUpdate: (state) => {
      setTask(state.task)
      setModel(state.model)
    },
    onMessage: (message) => {
      if (!isString(message.data)) return
      const parsed = parseJson(message.data)
      const failure = setupError(parsed)

      if (failure) {
        setConnectionError(`The session could not start: ${failure}. Retrying…`)

        return
      }

      if (!isPiEvents(parsed)) return
      setConnectionError('')
      batcher.push(parsed.events)
    },
    onClose: (event) => {
      if (event.code === NORMAL_CLOSURE) return
      // Keep a startup failure's message; it says more than this one.
      setConnectionError((current) => current || 'Connection to the session lost. Reconnecting…')
    },
    onConnectionError: (failure) => setError(failure.message),
  })

  const catalog = useSessionRegistry()
  const registry = catalog.agent

  // Listed again whenever a tool call or run may have changed the workspace.
  const fileList = useRemote(`files:${filesVersion}`, () => agent.stub.listFiles())
  const files = fileList.value ?? NO_FILES
  // The chosen file while it still exists, else the first.
  const selectedPath = files.some((file) => file.path === chosenPath) ? chosenPath : (files[0]?.path ?? '')

  useEffect(() => {
    if (!isReady) return
    let ignore = false
    // The picker is optional: without a list it stays hidden.
    agent.stub.listModels().then((list) => {
      if (!ignore) setModels(list)
    }, () => {})

    return () => { ignore = true }
  }, [agent.stub, isReady])

  const changes = useTaskChanges(agent.stub, task, filesVersion)
  const listRepositories = useCallback(() => registry.stub.listRepositories(), [registry.stub])

  useEffect(() => {
    let ignore = false
    registry.stub.getSession(sessionId).then((session) => {
      if (ignore) return
      setSummary(session)

      if (session) return
      // The registry answers this session's socket with 404, and the client
      // would retry it forever.
      setError('This session does not exist. It may have been deleted.')
      agent.close()
    }).catch((caught) => {
      if (!ignore) setError(errorMessage(caught))
    })

    return () => { ignore = true }
  }, [agent, registry.stub, sessionId])

  useEffect(() => () => batcher.cancel(), [batcher])

  // Read again when the file changes on disk, as its listed mtime shows.
  const selectedFileMtime = files.find((file) => file.path === selectedPath)?.mtime
  const selectedFile = useRemote(selectedPath ? `file:${selectedFileMtime}:${selectedPath}` : null, () => agent.stub.readWorkspaceFile(selectedPath))
  const fileContent = selectedFile.current?.content ?? ''
  const fileError = selectedFile.error

  const transcript = useMemo(() => transcriptEntries(view), [view])
  const isRunning = view.running || isSubmitting

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: isRunning ? 'auto' : 'smooth' })
  }, [transcript.entries, isRunning])

  async function submit(event: SubmitEvent<HTMLFormElement>) {
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
      if (view.running) {
        await agent.stub.steer(prompt)
      } else {
        // A first prompt titles the session; the live catalog brings the title.
        await agent.stub.submit(prompt)
      }
    } catch (caught) {
      setInput(prompt)
      setError(errorMessage(caught))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function chooseModel(id: string) {
    try {
      await agent.stub.setModel(id)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function rename(name: string | undefined) {
    try {
      setSummary(await registry.stub.renameSession(sessionId, name))
    } catch (caught) {
      setError(errorMessage(caught))
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

  // The browser's Live View tabs, or null when this deployment runs no browser.
  const browserLiveView = useCallback(() => agent.stub.browserLiveView(), [agent.stub])

  return {
    abort: async () => { try { await agent.stub.abort() } catch (caught) { setError(errorMessage(caught)) } },
    activeTextId: transcript.activeTextId,
    browserLiveView,
    changes,
    canDownload: Boolean(selectedPath && selectedFile.current?.path === selectedPath),
    downloadSelectedFile,
    entries: transcript.entries,
    error: error || connectionError || view.error,
    fileContent,
    fileError,
    files,
    filesError: fileList.error,
    filesLoading: fileList.loading,
    handleTranscriptScroll,
    input,
    isReady,
    isRunning,
    // Suggestions only make sense until the session has its repository.
    listRepositories: task ? undefined : listRepositories,
    mobileView,
    model,
    models,
    queued: view.queued,
    refreshFiles: fileList.reload,
    rename,
    selectedPath,
    setInput,
    setMobileView,
    setModel: chooseModel,
    setSelectedPath,
    submit,
    // The live catalog's copy follows titles and pull requests as they change.
    summary: catalog.sessions.find((session) => session.id === sessionId) ?? summary,
    task,
    transcriptRef,
  }
}
