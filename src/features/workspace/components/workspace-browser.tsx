import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Check, Copy, Download, FileText, RefreshCw } from 'lucide-react'
import type { WorkspaceFile } from '../../../shared/pi-contract'

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
    <section id="files-panel" className="workspace-panel" role="tabpanel" aria-label="Files" aria-busy={filesLoading}>
      <header className="workspace-header">
        <strong>Workspace{files.length > 0 && <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>}</strong>
        <div>
          <Button
            shape="square"
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={filesLoading}
            title="Refresh files"
            aria-label="Refresh files"
            icon={<RefreshCw size={14} className={filesLoading ? 'spinning' : ''} />}
          />
        </div>
      </header>

      <div className="file-list" aria-label="Workspace files">
        {filesLoading && files.length === 0 && <p className="file-state">Loading files…</p>}
        {filesError && <p className="file-error" role="alert">{filesError}</p>}
        {!filesLoading && !filesError && files.length === 0 && <p className="file-empty">No files yet. Files Pi creates will appear here.</p>}
        {files.map((file) => {
          const { name, dir } = splitPath(file.path)
          return (
            <button
              className={selectedPath === file.path ? 'selected' : ''}
              key={file.path}
              onClick={() => onSelectPath(file.path)}
              aria-pressed={selectedPath === file.path}
              title={file.path}
            >
              <FileText size={14} />
              <span className="file-label"><span className="file-name">{name}</span>{dir && <span className="file-dir"><bdi>{dir}</bdi></span>}</span>
              <span className="file-size">{formatBytes(file.size)}</span>
            </button>
          )
        })}
      </div>

      {files.length > 0 && <div className="file-preview">
        {selectedPath ? (
          <>
            <header className="file-preview-header">
              <span title={selectedPath}><bdi>{selectedPath}</bdi></span>
              <div className="file-preview-actions">
                {markdown && (
                  <fieldset className="view-switch" aria-label="Markdown view">
                    <button type="button" aria-pressed={markdownView === 'preview'} onClick={() => setMarkdownView('preview')}>Preview</button>
                    <button type="button" aria-pressed={markdownView === 'source'} onClick={() => setMarkdownView('source')}>Source</button>
                  </fieldset>
                )}
                <Button
                  shape="square"
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy()}
                  disabled={!canDownload}
                  title={copied ? 'Copied' : 'Copy contents'}
                  aria-label={copied ? 'Copied' : 'Copy contents'}
                  icon={copied ? <Check size={14} /> : <Copy size={14} />}
                />
                <Button
                  shape="square"
                  size="sm"
                  variant="ghost"
                  onClick={onDownload}
                  disabled={!canDownload}
                  title="Download file"
                  aria-label="Download file"
                  icon={<Download size={14} />}
                />
              </div>
            </header>
            {fileError ? <p className="file-error" role="alert">{fileError}</p> : (
              <Suspense fallback={<pre className="code-viewer"><code>{fileContent}</code></pre>}>
                {showPreview
                  ? <MarkdownFile content={fileContent} />
                  : <HighlightedFile content={fileContent} path={selectedPath} />}
              </Suspense>
            )}
          </>
        ) : (
          <div className="preview-placeholder">Select a file to preview</div>
        )}
      </div>}
    </section>
  )
}
