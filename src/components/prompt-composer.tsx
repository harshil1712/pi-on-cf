import { useRef, useState, type FormEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { InputArea } from '@cloudflare/kumo/components/input'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Select } from '@cloudflare/kumo/components/select'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowUpIcon, CubeIcon, LockSimpleIcon, StopIcon } from '@phosphor-icons/react'
import type { ModelOption, Repository } from '~/contract'
import { mentionQueryAt } from '~/lib/repo-mention'

const SUGGESTION_LIMIT = 8

type PromptComposerProps = {
  input: string
  isReady: boolean
  isRunning: boolean
  onAbort: () => void
  onInputChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  /** Replaces the placeholder that follows the session's state. */
  placeholder?: string
  /** Offers `@owner/name` suggestions while the session has no repository. */
  repositories?: () => Promise<Repository[]>
  /** The models the picker offers; without any, there is no picker. */
  models?: ModelOption[]
  model?: string
  onModelChange?: (id: string) => void
}

export function PromptComposer({ input, isReady, isRunning, onAbort, onInputChange, onSubmit, placeholder, repositories, models, model, onModelChange }: PromptComposerProps) {
  const sendLabel = isRunning ? 'Steer' : 'Send'
  const field = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [repos, setRepos] = useState<Repository[] | null>(null)
  const [reposError, setReposError] = useState('')
  const [active, setActive] = useState(0)
  const loading = useRef(false)

  const query = mention?.query.toLowerCase() ?? ''
  const suggestions = mention && repos ? repos.filter(({ repo }) => repo.toLowerCase().includes(query)).slice(0, SUGGESTION_LIMIT) : []
  const open = Boolean(mention)

  function track(value: string, caret: number) {
    const found = repositories ? mentionQueryAt(value, caret) : null
    setMention(found && { ...found, end: caret })
    setActive(0)
    if (!found || !repositories || loading.current) return
    // Loaded once, at the first `@`.
    loading.current = true
    repositories().then(setRepos, (caught: unknown) => {
      loading.current = false
      setReposError(caught instanceof Error ? caught.message : String(caught))
    })
  }

  function choose(repo: string) {
    if (!mention) return
    const before = `${input.slice(0, mention.start)}@${repo} `
    onInputChange(before + input.slice(mention.end))
    setMention(null)
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.setSelectionRange(before.length, before.length)
    })
  }

  return (
    <>
      {/* The form draws the field, as Kumo's InputGroup does, so the actions sit inside it. */}
      <form className="relative flex flex-col gap-1 rounded-xl bg-kumo-control p-2 ring ring-kumo-line focus-within:ring-[1.5px] focus-within:ring-kumo-focus/50" onSubmit={onSubmit}>
        {open && (
          <div
            id="repo-suggestions"
            aria-label="Repositories"
            className="absolute right-0 bottom-full left-0 mb-2 max-h-72 overflow-y-auto rounded-lg bg-kumo-base p-1 shadow-lg ring ring-kumo-line"
          >
            {/* The field keeps focus, so the highlighted repository is announced here. */}
            <output className="sr-only" aria-live="polite">{suggestions[active] ? `${suggestions[active].repo}, ${active + 1} of ${suggestions.length}` : ''}</output>
            {!repos && !reposError && <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-kumo-subtle"><Loader size="sm" />Loading repositories…</div>}
            {reposError && <div className="px-2.5 py-2 text-sm text-kumo-danger" role="alert">{reposError}</div>}
            {repos && suggestions.length === 0 && <div className="px-2.5 py-2 text-sm text-kumo-subtle">No repository matches “{mention?.query}”. Type owner/name to use another.</div>}
            {suggestions.map(({ repo, private: isPrivate, description }, index) => (
              <button
                type="button"
                tabIndex={-1}
                key={repo}
                aria-pressed={index === active}
                className={cn('flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-sm', index === active ? 'bg-kumo-fill' : 'hover:bg-kumo-tint')}
                // Keep focus in the field, so the caret stays where the mention is.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(repo)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="shrink-0 font-medium">{repo}</span>
                {isPrivate && <LockSimpleIcon size={12} className="shrink-0 self-center text-kumo-subtle" aria-label="Private" />}
                {description && <span className="min-w-0 truncate text-xs text-kumo-subtle">{description}</span>}
              </button>
            ))}
          </div>
        )}
        <InputArea
          ref={field}
          id="prompt"
          aria-label="Message Pi"
          aria-controls={open ? 'repo-suggestions' : undefined}
          className="min-h-10 bg-transparent px-1.5 ring-0 focus:ring-0"
          value={input}
          onValueChange={onInputChange}
          onChange={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
          onClick={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
          // Focus given by code, such as a home-page starter that leaves the caret after its `@`, opens the picker too.
          onFocus={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => setMention(null)}
          onKeyDown={(event) => {
            if (open && suggestions.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActive((current) => (current + step + suggestions.length) % suggestions.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                choose(suggestions[active]!.repo)
                return
              }
            }
            if (open && event.key === 'Escape') {
              event.preventDefault()
              setMention(null)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={placeholder ?? (!isReady
            ? 'Connecting…'
            : isRunning
              ? 'Steer Pi — it reads this after the current step'
              : repositories ? 'Ask Pi anything · type @ to work on a GitHub repository' : 'Ask Pi to inspect, create, or edit files')}
          autoResize
          maxRows={10}
          disabled={!isReady}
        />
        {/* The field's toolbar: the model on the left, the actions on the right. */}
        <div className="flex items-center gap-1.5">
          {models?.length ? (
            <Select
              aria-label="Model"
              size="sm"
              className="w-auto max-w-56 gap-1.5 bg-transparent px-2 text-kumo-subtle shadow-none ring-0 hover:bg-kumo-tint hover:text-kumo-default"
              items={models.map(({ id, label }) => ({ value: id, label }))}
              value={model || null}
              renderValue={(id) => (
                <span className="flex min-w-0 items-center gap-1.5">
                  <CubeIcon size={14} className="shrink-0" />
                  <span className="truncate">{models.find((option) => option.id === id)?.label ?? id}</span>
                </span>
              )}
              onValueChange={(id) => { if (typeof id === 'string' && id !== model) onModelChange?.(id) }}
              // Pi would switch from its next request; keeping the choice to idle sessions keeps the effect obvious.
              disabled={!isReady || isRunning}
              side="top"
              align="start"
            />
          ) : null}
          <span className="flex-1" />
          {isRunning && (
            <Button type="button" variant="secondary" shape="square" onClick={onAbort} aria-label="Stop" title="Stop" icon={<StopIcon weight="fill" />} />
          )}
          <Button type="submit" variant="primary" shape="square" disabled={!isReady || !input.trim()} aria-label={sendLabel} title={`${sendLabel} (Enter)`} icon={<ArrowUpIcon weight="bold" />} />
        </div>
      </form>
      <p className="mx-1 mt-1.5 text-center text-xs text-kumo-subtle max-md:hidden">
        <kbd className="font-medium">Enter</kbd> to send · <kbd className="font-medium">Shift</kbd>+<kbd className="font-medium">Enter</kbd> for a new line
      </p>
    </>
  )
}
