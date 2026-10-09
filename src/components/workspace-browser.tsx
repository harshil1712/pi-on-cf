import { lazy, Suspense, useEffect, useState } from 'react'
import { Button, RefreshButton } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowLeftIcon, CheckIcon, CopyIcon, DownloadSimpleIcon, FileTextIcon, FolderOpenIcon } from '@phosphor-icons/react'
import type { WorkspaceFile } from '~/contract'
import { CODE_VIEWER } from './code-viewer'

// Shiki and the Markdown renderer load on demand, outside the main bundle.
const HighlightedFile = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedFile })))
const MarkdownFile = lazy(() => import('./highlighted-code').then((module) => ({ default: module.MarkdownFile })))

const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

function formatBytes(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

type WorkspaceBrowserProps = {
  canDownload: boolean
  fileContent: string
  fileError: string
  files: WorkspaceFile[]
  filesError: string
  filesLoading: boolean
  onDownload: () => void
  onRefresh: () => void
  onSelectPath: (path: string) => void
  selectedPath: string
}

function splitPath(path: string) {
  const index = path.lastIndexOf('/')
  const dir = path.slice(0, index).replace(/^\/workspace/, '')
  return { name: path.slice(index + 1), dir: dir ? `${dir}/` : '' }
}

export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const { canDownload, fileContent, fileError, files, filesError, filesLoading, onDownload, onRefresh, onSelectPath, selectedPath } = props
  // Markdown opens rendered; the choice carries over to the next Markdown file.
  const [markdownView, setMarkdownView] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)
  // A tap on a file opens it full-screen on a phone, with this as the way back.
  // Desktops share the panel between the list and the preview instead.
  const [drilledIn, setDrilled] = useState(false)
  // A file that disappears from the list (or an empty list) drops the phone back to the list.
  const drilled = drilledIn && Boolean(selectedPath)
  const markdown = isMarkdownPath(selectedPath)
  const showPreview = markdown && markdownView === 'preview'

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => setCopied(false), [selectedPath])

  async function copy() {
    try {
      await navigator.clipboard.writeText(fileContent)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; Download still works.
    }
  }

  return (
    <section id="files-panel" className="flex min-h-0 min-w-0 flex-1 flex-col" role="tabpanel" aria-label="Files" aria-busy={filesLoading}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-kumo-hairline pr-2 pl-3.5">
        <span className="text-sm font-semibold">
          Workspace{files.length > 0 && <span className="ml-1.5 font-normal text-kumo-subtle">{files.length} {files.length === 1 ? 'file' : 'files'}</span>}
        </span>
        <RefreshButton size="sm" variant="ghost" onClick={onRefresh} loading={filesLoading} aria-label="Refresh files" title="Refresh files" />
      </header>
      {/* Mobile: the list fills the panel until a file is tapped. Desktop: it caps itself so the preview fits below. */}
      <div className={cn('min-h-18 flex-1 overflow-y-auto p-1', files.length > 0 && 'md:max-h-2/5 md:shrink md:border-b md:border-kumo-hairline', drilled && 'hidden md:block')} aria-label="Workspace files">
        {filesLoading && files.length === 0 && <div className="flex items-center justify-center gap-2 px-3 py-5 text-sm text-kumo-subtle"><Loader size="sm" />Loading files…</div>}
        {filesError && <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{filesError}</p>}
        {!filesLoading && !filesError && files.length === 0 && (
          <Empty size="sm" className="border-0 bg-transparent" icon={<FolderOpenIcon size={32} className="text-kumo-inactive" />} title="No files yet" description="Files Pi creates will appear here." />
        )}
        {files.map((file) => {
          const { name, dir } = splitPath(file.path)
          const selected = selectedPath === file.path
          return (
            <button
              className={cn('flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2.5 text-left md:py-1.5', selected ? 'bg-kumo-fill' : 'hover:bg-kumo-tint active:bg-kumo-fill')}
              key={file.path}
              onClick={() => { setDrilled(true); onSelectPath(file.path) }}
              aria-pressed={selected}
              title={file.path}
            >
              <FileTextIcon size={14} className="shrink-0 text-kumo-subtle" />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
                <span className="shrink-0 text-sm">{name}</span>
                {/* Right-to-left so a long directory is clipped at its start, keeping the nearest folder visible. */}
                {dir && <span className="min-w-0 truncate text-left text-xs text-kumo-subtle [direction:rtl]"><bdi>{dir}</bdi></span>}
              </span>
              <span className="shrink-0 text-[11px] text-kumo-subtle tabular-nums">{formatBytes(file.size)}</span>
            </button>
          )
        })}
      </div>
      {files.length > 0 && <div className={cn('min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden', drilled ? 'grid' : 'hidden md:grid')}>
        {selectedPath ? (
          <>
            <header className="flex h-10 min-w-0 items-center justify-between gap-2 border-b border-kumo-hairline pr-2 pl-1.5 md:pl-3.5">
              <Button
                className="md:hidden"
                shape="square"
                size="sm"
                variant="ghost"
                aria-label="Back to files"
                title="Back to files"
                icon={<ArrowLeftIcon />}
                onClick={() => { setDrilled(false); onSelectPath('') }}
              />
              <span className="min-w-0 truncate text-left font-mono text-xs text-kumo-subtle [direction:rtl]" title={selectedPath}><bdi>{selectedPath}</bdi></span>
              <div className="flex shrink-0 items-center gap-0.5">
                {markdown && (
                  <div className="mr-1.5">
                    <Tabs
                      size="sm"
                      variant="segmented"
                      tabs={[{ value: 'preview', label: 'Preview' }, { value: 'source', label: 'Source' }]}
                      value={markdownView}
                      onValueChange={(value) => setMarkdownView(value as 'preview' | 'source')}
                    />
                  </div>
                )}
                <Button
                  shape="square"
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy()}
                  disabled={!canDownload}
                  title={copied ? 'Copied' : 'Copy contents'}
                  aria-label={copied ? 'Copied' : 'Copy contents'}
                  icon={copied ? <CheckIcon className="text-kumo-success" /> : CopyIcon}
                />
                <Button
                  shape="square"
                  size="sm"
                  variant="ghost"
                  onClick={onDownload}
                  disabled={!canDownload}
                  title="Download file"
                  aria-label="Download file"
                  icon={DownloadSimpleIcon}
                />
              </div>
            </header>
            {fileError ? <p className="px-3.5 py-3 text-sm text-kumo-danger" role="alert">{fileError}</p> : (
              <Suspense fallback={<pre className={CODE_VIEWER}><code>{fileContent}</code></pre>}>
                {showPreview
                  ? <MarkdownFile content={fileContent} />
                  : <HighlightedFile content={fileContent} path={selectedPath} />}
              </Suspense>
            )}
          </>
        ) : (
          <div className="row-span-full grid place-items-center text-sm text-kumo-subtle">Select a file to preview</div>
        )}
      </div>}
    </section>
  )
}
