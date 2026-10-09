import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { BugBeetleIcon, BookOpenTextIcon, BroomIcon, GitBranchIcon, TestTubeIcon, type Icon } from '@phosphor-icons/react'
import { useSessionRegistry } from '~/hooks/use-session-registry'
import { PiMark } from './pi-mark'
import { TopBar } from './top-bar'
import { PromptComposer } from './prompt-composer'
import type { ModelOption } from '~/contract'

/**
 * Ways into a task. Each leaves the caret after `@`, so the repository
 * picker opens and the rest of the prompt is the user's.
 */
const STARTERS: { icon: Icon; title: string; detail: string; prompt: string }[] = [
  { icon: BookOpenTextIcon, title: 'Understand a codebase', detail: 'How it is laid out, and where to start', prompt: 'Explain how @' },
  { icon: BugBeetleIcon, title: 'Fix a bug', detail: 'Reproduce it, fix it, open a pull request', prompt: 'In @' },
  { icon: TestTubeIcon, title: 'Add tests', detail: 'Cover code that has none', prompt: 'Add tests to @' },
  { icon: BroomIcon, title: 'Tidy up', detail: 'Docs, dead code and small cleanups', prompt: 'Tidy up @' },
]

const RECENT_REPOSITORY_LIMIT = 6

function greeting(hour: number) {
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

/** Where a session starts: tell Pi what to do, and it opens one with that prompt. */
export function HomePage() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  // The server cannot know the visitor's hour, so greet after hydration.
  const [hello, setHello] = useState('')
  useEffect(() => setHello(greeting(new Date().getHours())), [])
  const listRepositories = useCallback(() => registry.agent.stub.listRepositories(), [registry.agent.stub])
  // The registry lists the default first, so it starts selected. Without a list there is no picker.
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState('')
  useEffect(() => {
    let ignore = false
    registry.agent.stub.listModels().then((list) => {
      if (ignore) return
      setModels(list)
      setModel((current) => current || (list[0]?.id ?? ''))
    }, () => {})
    return () => { ignore = true }
  }, [registry.agent.stub])
  const recentRepositories = [...new Set(registry.sessions.flatMap((session) => session.repo ? [session.repo] : []))].slice(0, RECENT_REPOSITORY_LIMIT)

  async function start(firstPrompt: string) {
    if (starting) return
    setStarting(true)
    setError('')
    try {
      const session = await registry.agent.stub.createSession({ prompt: firstPrompt, ...(model ? { model } : {}) })
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStarting(false)
    }
  }

  /** Put `text` in the composer with the caret at its end, where the `@` picker opens. */
  function compose(text: string) {
    setPrompt(text)
    requestAnimationFrame(() => {
      const field = document.getElementById('prompt') as HTMLTextAreaElement | null
      // Caret first: focusing reads it to decide whether to open the picker.
      field?.setSelectionRange(text.length, text.length)
      field?.focus()
    })
  }

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The π mark's orange, as a faint glow behind the page's one question. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-112 bg-[radial-gradient(40%_55%_at_50%_0%,color-mix(in_oklab,var(--color-pi-brand)_5%,transparent),transparent)]" />
      <TopBar bordered={false} />
      <div className="relative mx-auto flex w-full max-w-180 flex-1 flex-col justify-center px-4 pb-16 md:px-6">
        <div className="mb-7 flex flex-col items-center gap-4 text-center animate-enter">
          <PiMark size="lg" />
          <div className="flex flex-col gap-2">
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-balance md:text-[34px]">
              <span className="text-kumo-subtle">{hello ? `${hello}. ` : ''}</span>What should Pi work on?
            </h1>
            <section aria-label="Start from" className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-2 animate-enter [animation-delay:180ms]">
              {STARTERS.map(({ icon: StarterIcon, title, detail, prompt: text }) => (
                <button
                  key={title}
                  type="button"
                  onClick={() => compose(text)}
                  className="group flex cursor-pointer items-start gap-3 rounded-xl bg-kumo-base p-3.5 text-left ring ring-kumo-line transition hover:bg-kumo-tint hover:ring-kumo-fill active:bg-kumo-tint active:ring-kumo-fill focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-kumo-recessed text-kumo-subtle transition group-hover:text-kumo-default">
                    <StarterIcon size={17} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{title}</span>
                    <span className="text-xs text-kumo-subtle">{detail}</span>
                  </span>
                </button>
              ))}
            </section>
          </div>
        </div>

        <div className="animate-enter [animation-delay:60ms]">
          {error && <Banner className="mb-3" variant="error" role="alert" description={error} />}
          <PromptComposer
            input={prompt}
            isReady={!starting}
            isRunning={false}
            onAbort={() => {}}
            onInputChange={setPrompt}
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              if (prompt.trim()) void start(prompt.trim())
            }}
            placeholder={starting ? 'Starting a session…' : 'Describe a task, or type @ to pick a repository'}
            repositories={listRepositories}
            models={models}
            model={model}
            onModelChange={setModel}
          />
        </div>

        {recentRepositories.length > 0 && (
          <section aria-labelledby="recent-repositories" className="mt-5 flex flex-wrap items-center justify-center gap-1.5 animate-enter [animation-delay:120ms]">
            <h2 id="recent-repositories" className="mr-1 text-xs text-kumo-subtle">Recent</h2>
            {recentRepositories.map((repo) => (
              <Button key={repo} size="xs" variant="secondary" icon={<GitBranchIcon size={12} />} onClick={() => compose(`${prompt.trim() ? `${prompt.trim()} ` : ''}@${repo} `)}>
                {repo}
              </Button>
            ))}
          </section>
        )}
      </div>
    </main>
  )
}
