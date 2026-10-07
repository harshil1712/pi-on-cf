import { lazy, memo, Suspense } from 'react'
import type { RefObject, UIEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Streamdown } from 'streamdown'
import type { TranscriptEntry } from '../transcript'
import { ActivityCard } from './activity-card'

const HighlightedMarkdown = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedMarkdown })))

function latestAssistantText(entries: TranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type === 'message' && entry.role === 'assistant') return entry.text
  }
  return ''
}

function isUserMessage(entry: TranscriptEntry | undefined) {
  return entry?.type === 'message' && entry.role === 'user'
}

type TranscriptViewProps = {
  activeTextId: string
  entries: TranscriptEntry[]
  isRunning: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  onTryOperation: () => void
  transcriptRef: RefObject<HTMLDivElement | null>
}

export function TranscriptView({ activeTextId, entries, isRunning, onScroll, onTryOperation, transcriptRef }: TranscriptViewProps) {
  const assistantText = latestAssistantText(entries)

  return (
    <div className="transcript" ref={transcriptRef} onScroll={onScroll} aria-busy={isRunning} role="log" aria-live="off">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{isRunning ? 'Pi is working.' : assistantText ? `Pi replied: ${assistantText}` : 'Pi is ready.'}</span>
      {entries.length === 0 ? (
        <div className="empty-state">
          <span className="brand-mark" aria-hidden="true">π</span>
          <h2>What should Pi work on?</h2>
          <p>Pi runs inside a Cloudflare Durable Object and can read and write files in this session’s workspace.</p>
          <Button variant="secondary" size="sm" onClick={onTryOperation}>Try an example</Button>
        </div>
      ) : (
        <div className="transcript-inner">
          {entries.map((entry) => <TranscriptRow active={entry.id === activeTextId} entry={entry} isRunning={isRunning} key={entry.id} />)}
          {isRunning && isUserMessage(entries.at(-1)) && (
            <div className="pending" aria-hidden="true"><Loader size={14} /> Working…</div>
          )}
        </div>
      )}
    </div>
  )
}

const TranscriptRow = memo(function TranscriptRow({ active, entry, isRunning }: {
  active: boolean
  entry: TranscriptEntry
  isRunning: boolean
}) {
  if (entry.type !== 'message') return <ActivityCard entry={entry} />

  return (
    <article className={`message message-${entry.role}`}>
      <span className="sr-only">{entry.role === 'user' ? 'You:' : 'Pi:'}</span>
      <div className="message-body">
        {entry.role === 'assistant' && entry.text ? entry.text.includes('```') ? (
          <Suspense fallback={<Streamdown>{entry.text}</Streamdown>}>
            <HighlightedMarkdown active={active}>{entry.text}</HighlightedMarkdown>
          </Suspense>
        ) : (
          <Streamdown caret={active ? 'block' : undefined} isAnimating={active}>{entry.text}</Streamdown>
        ) : entry.text || (isRunning && active ? <span className="cursor" /> : '')}
      </div>
    </article>
  )
})
