import type { RefObject, UIEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { code } from '@streamdown/code'
import { Streamdown } from 'streamdown'
import type { TranscriptEntry } from '../transcript'
import { ActivityCard } from './activity-card'

const markdownPlugins = { code }

type TranscriptViewProps = {
  activeTextId: string
  entries: TranscriptEntry[]
  isRunning: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  onTryOperation: () => void
  transcriptRef: RefObject<HTMLDivElement | null>
}

export function TranscriptView({ activeTextId, entries, isRunning, onScroll, onTryOperation, transcriptRef }: TranscriptViewProps) {
  return (
    <div className="transcript" ref={transcriptRef} onScroll={onScroll} aria-busy={isRunning}>
      <span className="sr-only" aria-live="polite">{isRunning ? 'Pi is working.' : 'Pi is ready.'}</span>
      {entries.length === 0 && (
        <div className="empty-state">
          <span className="oversized-pi">π</span>
          <div>
            <h2>A coding agent with no server.</h2>
            <p>Pi’s agent loop is running inside a Cloudflare Durable Object. Give it a file to create.</p>
            <Button className="empty-state-action" variant="ghost" onClick={onTryOperation}>TRY A FILE OPERATION</Button>
          </div>
        </div>
      )}

      {entries.map((entry) => {
        if (entry.type !== 'message') return <ActivityCard entry={entry} key={entry.id} />

        return (
          <article className={`message message-${entry.role}`} key={entry.id}>
            <div className="message-role">{entry.role === 'user' ? 'YOU' : 'PI'}</div>
            <div className="message-body">
              {entry.role === 'assistant' && entry.text ? (
                <Streamdown
                  caret={entry.id === activeTextId ? 'block' : undefined}
                  controls={{ code: { download: false } }}
                  isAnimating={entry.id === activeTextId}
                  plugins={markdownPlugins}
                >
                  {entry.text}
                </Streamdown>
              ) : entry.text || (isRunning && entry.id === activeTextId ? <span className="cursor" /> : '')}
            </div>
          </article>
        )
      })}
    </div>
  )
}
