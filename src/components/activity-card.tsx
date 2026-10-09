import { useEffect, useState } from 'react'
import { Collapsible } from '@cloudflare/kumo/components/collapsible'
import { Loader } from '@cloudflare/kumo/components/loader'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowCounterClockwiseIcon, BrainIcon, CaretRightIcon, ScissorsIcon, WarningCircleIcon, WrenchIcon } from '@phosphor-icons/react'
import type { TranscriptEntry } from '~/lib/transcript'

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
  let icon = <WrenchIcon size={14} />
  let label: string
  let detail = ''

  if (entry.type === 'reasoning') {
    icon = <BrainIcon size={14} />
    label = running ? 'Thinking…' : 'Thought'
  } else if (entry.type === 'summary') {
    icon = entry.kind === 'compaction' ? <ScissorsIcon size={14} /> : <ArrowCounterClockwiseIcon size={14} />
    label = entry.kind === 'compaction' ? 'Compaction summary' : 'Context reset'
  } else {
    label = toolLabel(entry.name)
    detail = toolArgumentSummary(entry.args)
  }
  if (running && entry.type === 'tool') icon = <Loader size={14} aria-label="Tool running" />
  if (error) icon = <WarningCircleIcon size={14} aria-label="Failed" />

  return (
    // Tool calls, reasoning, and checkpoints are quiet single-line rows tucked under the message above.
    <Collapsible.Root className="activity group/activity -mt-3 mb-5 animate-enter [.activity+&]:-mt-4.5" open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className={cn(
        '-ml-1.5 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-kumo-tint active:bg-kumo-fill',
        error ? 'text-kumo-danger' : 'text-kumo-subtle hover:text-kumo-default active:text-kumo-default',
      )}>
        <span className="flex shrink-0">{icon}</span>
        <span className="shrink-0 font-medium">{label}</span>
        {detail && <span className="min-w-0 truncate font-mono text-xs opacity-85">{detail}</span>}
        <CaretRightIcon size={13} className="shrink-0 transition-transform group-data-[open]/activity:rotate-90" aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-1 mb-2 divide-y divide-kumo-hairline overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base">
        {entry.type === 'tool' ? (
          <>
            <ActivitySection label="Input">{JSON.stringify(entry.args ?? {}, null, 2)}</ActivitySection>
            {entry.result !== undefined && <ActivitySection label={error ? 'Error' : 'Output'}>{stringify(entry.result)}</ActivitySection>}
            {entry.images?.map((image, index) => (
              <a key={index} href={image.src} target="_blank" rel="noreferrer" title={image.alt} className="block">
                <img src={image.src} alt={image.alt} loading="lazy" className="max-h-72 w-full rounded-b-lg object-cover object-top" />
              </a>
            ))}
          </>
        ) : <div className="max-h-60 overflow-y-auto px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-kumo-subtle">{entry.text}</div>}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

function ActivitySection({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <span className="block px-3 pt-2 text-[11px] font-medium text-kumo-subtle">{label}</span>
      <pre className="m-0 max-h-55 overflow-auto px-3 pt-1 pb-2.5 font-mono text-xs/normal whitespace-pre-wrap wrap-anywhere">{children}</pre>
    </div>
  )
}
