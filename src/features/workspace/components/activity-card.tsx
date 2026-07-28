import { useEffect, useState } from 'react'
import { Collapsible } from '@cloudflare/kumo/components/collapsible'
import { Loader } from '@cloudflare/kumo/components/loader'
import { BrainCircuit, Check, CircleX, GitBranch, Scissors, Wrench } from 'lucide-react'
import type { TranscriptEntry } from '../transcript'

function toolArgumentSummary(args: unknown) {
  if (!args || typeof args !== 'object') return ''
  const values = args as Record<string, unknown>
  for (const key of ['path', 'pattern', 'query', 'search']) {
    if (typeof values[key] === 'string') return values[key]
  }
  return ''
}

export function ActivityCard({ entry }: { entry: Extract<TranscriptEntry, { type: 'reasoning' | 'summary' | 'tool' }> }) {
  const [open, setOpen] = useState(entry.status === 'running')

  useEffect(() => {
    if (entry.status === 'running') setOpen(true)
  }, [entry.status])

  const reasoning = entry.type === 'reasoning'
  const sessionSummary = entry.type === 'summary'
  const toolSummary = entry.type === 'tool' ? toolArgumentSummary(entry.args) : ''
  const heading = reasoning ? 'REASONING' : sessionSummary
    ? entry.kind === 'compaction' ? 'COMPACTION SUMMARY' : 'BRANCH SUMMARY'
    : entry.name.replaceAll('_', ' ').toUpperCase()
  const description = reasoning ? (entry.status === 'running' ? 'WORKING THROUGH THE TASK' : 'THOUGHT PROCESS')
    : sessionSummary ? 'SESSION CONTEXT CHECKPOINT'
    : (toolSummary || 'WORKSPACE OPERATION')

  return (
    <Collapsible.Root
      className={`activity-card ${reasoning ? 'reasoning-card' : sessionSummary ? 'summary-card' : `tool-card status-${entry.status}`}`}
      open={open}
      onOpenChange={setOpen}
    >
      <Collapsible.Trigger className="activity-trigger">
        <span className="activity-icon">{reasoning ? <BrainCircuit size={15} /> : sessionSummary ? entry.kind === 'compaction' ? <Scissors size={14} /> : <GitBranch size={14} /> : <Wrench size={14} />}</span>
        <span className="activity-heading">
          <strong>{heading}</strong>
          <small>{description}</small>
        </span>
        <span className={`activity-status status-${entry.status}`}>
          {entry.status === 'running' && <Loader size={13} aria-label={reasoning ? 'Reasoning in progress' : 'Tool running'} />}
          {entry.status === 'complete' && <Check size={13} />}
          {entry.status === 'error' && <CircleX size={13} />}
          {entry.status}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className={reasoning || sessionSummary ? 'reasoning-content' : 'tool-arguments'}>
        {reasoning || sessionSummary ? entry.text : (
          <>
            <span>INPUT</span>
            <pre>{JSON.stringify(entry.args ?? {}, null, 2)}</pre>
          </>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
