import { lazy, Suspense, useState } from 'react'
import { Button, RefreshButton } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Loader } from '@cloudflare/kumo/components/loader'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowLeftIcon, GitDiffIcon } from '@phosphor-icons/react'
import type { SessionTask, TaskChange } from '~/contract'
import { CODE_VIEWER } from './code-viewer'

const HighlightedFile = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedFile })))

/** jsdiff's `Index:` and `====` preamble repeats the file name the list already shows. */
const withoutPreamble = (diff: string) => diff.replace(/^Index: .*\n=+\n/, '')

const STATUS_CLASS = { A: 'text-kumo-success', M: 'text-kumo-warning', D: 'text-kumo-danger' } as const

type ChangesBrowserProps = {
  changes: TaskChange[]
  diff: string
  diffError: string
  error: string
  loading: boolean
  onRefresh: () => void
  onSelectPath: (path: string) => void
  selectedPath: string
  task: SessionTask
}

/** The task's changes against its base commit: one row per file, then the selected file's diff. */
export function ChangesBrowser(props: ChangesBrowserProps) {
  const { changes, diff, diffError, error, loading, onRefresh, onSelectPath, selectedPath, task } = props
  // A tap on a file opens its diff full-screen on a phone, with this as the way back.
  // Desktops share the panel between the list and the diff instead.
  const [drilledIn, setDrilled] = useState(false)
  // A change that disappears from the list (or an empty list) drops the phone back to the list.
  const drilled = drilledIn && Boolean(selectedPath)
  const back = () => { setDrilled(false); onSelectPath('') }
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Changes" aria-busy={loading}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-kumo-hairline pr-2 pl-3.5">
        <span className="min-w-0 truncate text-sm font-semibold" title={`${task.branch} from ${task.baseBranch}`}>
          Changes<span className="ml-1.5 font-normal text-kumo-subtle">from {task.baseBranch}</span>
        </span>
        <RefreshButton size="sm" variant="ghost" onClick={onRefresh} loading={loading} aria-label="Refresh changes" title="Refresh changes" />
      </header>
      {/* Mobile: the list fills the panel until a file is tapped. Desktop: it caps itself so the diff fits below. */}
      <div className={cn('min-h-18 flex-1 overflow-y-auto p-1', changes.length > 0 && 'md:max-h-2/5 md:shrink md:border-b md:border-kumo-hairline', drilled && 'hidden md:block')} aria-label="Changed files">
        {loading && changes.length === 0 && <div className="flex items-center justify-center gap-2 px-3 py-5 text-sm text-kumo-subtle"><Loader size="sm" />Loading changes…</div>}
        {error && <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{error}</p>}
        {!loading && !error && changes.length === 0 && (
          <Empty size="sm" className="border-0 bg-transparent" icon={<GitDiffIcon size={32} className="text-kumo-inactive" />} title="No changes yet" description={`Changes Pi makes in ${task.repo} will appear here.`} />
        )}
        {changes.map((change) => {
          const selected = selectedPath === change.path
          return (
            <button
              className={cn('flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2.5 text-left md:py-1.5', selected ? 'bg-kumo-fill' : 'hover:bg-kumo-tint active:bg-kumo-fill')}
              key={change.path}
              onClick={() => { setDrilled(true); onSelectPath(change.path) }}
              aria-pressed={selected}
              title={change.path}
            >
              <span className={cn('w-3 shrink-0 font-mono text-xs font-semibold', STATUS_CLASS[change.status])}>{change.status}</span>
              <span className="min-w-0 flex-1 truncate text-left text-sm [direction:rtl]"><bdi>{change.path}</bdi></span>
              <span className="shrink-0 text-[11px] tabular-nums">
                <span className="text-kumo-success">+{change.insertions}</span> <span className="text-kumo-danger">−{change.deletions}</span>
              </span>
            </button>
          )
        })}
      </div>
      {changes.length > 0 && selectedPath && (
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', drilled ? '' : 'hidden md:flex')}>
          {/* The diff owns the screen once drilled, so its file gets its own named header on the way back. */}
          <header className="flex shrink-0 items-center gap-1 border-b border-kumo-hairline pr-2 pl-1.5 md:hidden">
            <Button
              shape="square"
              size="sm"
              variant="ghost"
              aria-label="Back to changed files"
              title="Back to changed files"
              icon={<ArrowLeftIcon />}
              onClick={back}
            />
            <span className="min-w-0 truncate font-mono text-xs text-kumo-subtle [direction:rtl]" title={selectedPath}><bdi>{selectedPath}</bdi></span>
          </header>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {diffError ? <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{diffError}</p> : (
              <Suspense fallback={<pre className={CODE_VIEWER}><code>{withoutPreamble(diff)}</code></pre>}>
                <HighlightedFile content={withoutPreamble(diff)} path={`${selectedPath}.diff`} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
