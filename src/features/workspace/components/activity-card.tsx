import { useEffect, useState } from 'react'
import { Collapsible } from '@cloudflare/kumo/components/collapsible'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Brain, ChevronRight, CircleAlert, RotateCcw, Scissors, Wrench } from 'lucide-react'
import type { TranscriptEntry } from '../transcript'

function toolArgumentSummary(args: unknown) {
  if (!args || typeof args !== 'object') return ''
  const values = args as Record<string, unknown>
  for (const key of ['path', 'command', 'source', 'pattern', 'query', 'search', 'name']) {
    if (typeof values[key] === 'string') return values[key]
  }
  return ''
}

function toolLabel(name: string) {
  const label = name.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function stringify(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function ActivityCard({ entry }: { entry: Extract<TranscriptEntry, { type: 'reasoning' | 'summary' | 'tool' }> }) {
  // Reasoning streams open so it can be followed; tool calls stay collapsed.
  const [open, setOpen] = useState(entry.type === 'reasoning' && entry.status === 'running')

  useEffect(() => {
    if (entry.type === 'reasoning') setOpen(entry.status === 'running')
  }, [entry.type, entry.status])

  const running = entry.status === 'running'
  const error = entry.status === 'error'
  let icon = <Wrench size={14} />
  let label: string
  let detail = ''

  if (entry.type === 'reasoning') {
    icon = <Brain size={14} />
    label = running ? 'Thinking…' : 'Thought'
  } else if (entry.type === 'summary') {
    icon = entry.kind === 'compaction' ? <Scissors size={14} /> : <RotateCcw size={14} />
    label = entry.kind === 'compaction' ? 'Compaction summary' : 'Context reset'
  } else {
    label = toolLabel(entry.name)
    detail = toolArgumentSummary(entry.args)
  }
  if (running && entry.type === 'tool') icon = <Loader size={14} aria-label="Tool running" />
  if (error) icon = <CircleAlert size={14} aria-label="Failed" />

  return (
    <Collapsible.Root className={`activity status-${entry.status}`} open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="activity-trigger">
        {icon}
        <span className="activity-label">{label}</span>
        {detail && <span className="activity-detail">{detail}</span>}
        <ChevronRight size={13} className="activity-chevron" aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="activity-content">
        {entry.type === 'tool' ? (
          <>
            <div className="activity-section">
              <span>Input</span>
              <pre>{JSON.stringify(entry.args ?? {}, null, 2)}</pre>
            </div>
            {entry.result !== undefined && (
              <div className="activity-section">
                <span>{error ? 'Error' : 'Output'}</span>
                <pre>{stringify(entry.result)}</pre>
              </div>
            )}
          </>
        ) : <div className="activity-text">{entry.text}</div>}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
