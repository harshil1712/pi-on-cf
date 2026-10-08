import { lazy, Suspense } from 'react'
import { RefreshButton } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Loader } from '@cloudflare/kumo/components/loader'
import { cn } from '@cloudflare/kumo/utils'
import { GitDiffIcon } from '@phosphor-icons/react'
import type { SessionTask, TaskChange } from '~/shared/pi-contract'
import { CODE_VIEWER } from './code-viewer'

const HighlightedFile = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedFile })))

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
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Changes" aria-busy={loading}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-kumo-hairline pr-2 pl-3.5">
        <span className="min-w-0 truncate text-sm font-semibold" title={`${task.branch} from ${task.baseBranch}`}>
          Changes<span className="ml-1.5 font-normal text-kumo-subtle">from {task.baseBranch}</span>
        </span>
        <RefreshButton size="sm" variant="ghost" onClick={onRefresh} loading={loading} aria-label="Refresh changes" title="Refresh changes" />
      </header>
      <div className={cn('min-h-18 overflow-y-auto p-1', changes.length > 0 ? 'max-h-2/5 shrink border-b border-kumo-hairline' : 'flex-1')} aria-label="Changed files">
        {loading && changes.length === 0 && <div className="flex items-center justify-center gap-2 px-3 py-5 text-sm text-kumo-subtle"><Loader size="sm" />Loading changes…</div>}
        {error && <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{error}</p>}
        {!loading && !error && changes.length === 0 && (
          <Empty size="sm" className="border-0 bg-transparent" icon={<GitDiffIcon size={32} className="text-kumo-inactive" />} title="No changes yet" description={`Changes Pi makes in ${task.repo} will appear here.`} />
        )}
        {changes.map((change) => {
          const selected = selectedPath === change.path
          return (
            <button
              className={cn('flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left', selected ? 'bg-kumo-fill' : 'hover:bg-kumo-tint')}
              key={change.path}
              onClick={() => onSelectPath(change.path)}
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
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {diffError ? <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{diffError}</p> : (
            <Suspense fallback={<pre className={CODE_VIEWER}><code>{diff}</code></pre>}>
              <HighlightedFile content={diff} path={`${selectedPath}.diff`} />
            </Suspense>
          )}
        </div>
      )}
    </section>
  )
}
