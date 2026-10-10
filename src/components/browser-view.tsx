import { LinkButton, RefreshButton } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Select } from '@cloudflare/kumo/components/select'
import { ArrowSquareOutIcon, GlobeIcon } from '@phosphor-icons/react'
import type { BrowserView } from '~/hooks/use-browser-view'

const tabLabel = (tab: { title?: string; pageUrl?: string }) => tab.title || tab.pageUrl || 'Untitled'

/**
 * Live View of Pi's browser, inside the Workspace panel so the chat stays
 * usable beside it: watch Pi work, or take over to log in, then tell Pi to
 * carry on.
 */
export function BrowserViewPanel({ browser }: { browser: BrowserView }) {
  const { tabs, selected, loading, error } = browser
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Browser" aria-busy={loading}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-hairline pr-2 pl-3.5">
        <span className="shrink-0 text-sm font-semibold">Browser</span>
        {tabs.length > 1 ? (
          <Select
            aria-label="Tab"
            size="sm"
            className="min-w-0 flex-1"
            items={tabs.map((tab) => ({ value: tab.targetId, label: tabLabel(tab) }))}
            value={selected?.targetId ?? null}
            onValueChange={(targetId) => { if (typeof targetId === 'string') void browser.select(targetId) }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle" title={selected?.pageUrl}>{selected?.pageUrl}</span>
        )}
        {selected && (
          <LinkButton href={selected.url} external variant="ghost" size="sm" shape="square" icon={<ArrowSquareOutIcon />} aria-label="Open in a new tab" title="Open in a new tab" />
        )}
        <RefreshButton size="sm" variant="ghost" onClick={() => void browser.refresh({ reconnect: true })} loading={loading} aria-label="Reconnect to Pi's browser" title="Reconnect" />
      </header>
      {error && <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{error}</p>}
      {selected ? (
        // A new URL is a new connection, so the frame is keyed on it.
        <iframe
          key={selected.url}
          src={selected.url}
          title={`Live View of ${tabLabel(selected)}`}
          className="min-h-0 w-full flex-1 border-0"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
        />
      ) : !loading && (
        <Empty
          size="sm"
          className="border-0 bg-transparent"
          icon={<GlobeIcon size={32} className="text-kumo-inactive" />}
          title="Pi’s browser isn’t open"
          description="It starts the next time Pi uses its browser tool. Watch it work here, or take over to log in, then tell Pi to carry on."
        />
      )}
    </section>
  )
}
