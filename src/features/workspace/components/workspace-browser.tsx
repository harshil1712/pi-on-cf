import { Button } from '@cloudflare/kumo/components/button'
import { Download, FileCode2, FolderOpen, RefreshCw } from 'lucide-react'
import type { WorkspaceFile } from '../../../shared/pi-contract'

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
  hidden: boolean
  onDownload: () => void
  onRefresh: () => void
  onSelectPath: (path: string) => void
  selectedPath: string
}

export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const { canDownload, fileContent, fileError, files, filesError, filesLoading, hidden, onDownload, onRefresh, onSelectPath, selectedPath } = props

  return (
    <section
      id="files-panel"
      className={`workspace-panel ${hidden ? 'mobile-hidden' : ''}`}
      role="tabpanel"
      aria-label="Files"
      aria-labelledby="files-tab"
      aria-busy={filesLoading}
    >
      <header className="workspace-header">
        <div>
          <span className="panel-kicker">DURABLE STORAGE</span>
          <strong>WORKSPACE FILES</strong>
        </div>
        <Button
          className="icon-button"
          shape="square"
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={filesLoading}
          title="Refresh files"
          aria-label="Refresh files"
          icon={<RefreshCw size={15} className={filesLoading ? 'spinning' : ''} />}
        />
      </header>

      <div className="file-list" aria-label="Workspace files">
        {filesLoading && files.length === 0 && <p className="file-state">SCANNING WORKSPACE...</p>}
        {filesError && <p className="file-error" role="alert">{filesError}</p>}
        {!filesLoading && files.length === 0 && (
          <div className="file-empty">
            <FolderOpen size={28} strokeWidth={1.5} />
            <strong>NO FILES YET</strong>
            <span>Ask Pi to create one.</span>
          </div>
        )}
        {files.map((file) => (
          <button
            className={selectedPath === file.path ? 'selected' : ''}
            key={file.path}
            onClick={() => onSelectPath(file.path)}
            aria-pressed={selectedPath === file.path}
          >
            <FileCode2 size={15} strokeWidth={1.7} />
            <span className="file-name">{file.path.split('/').pop()}</span>
            <span className="file-size">{formatBytes(file.size)}</span>
            <span className="file-path">{file.path}</span>
          </button>
        ))}
      </div>

      <div className="file-preview">
        {selectedPath ? (
          <>
            <header className="file-preview-header">
              <div>
                <strong>{selectedPath.split('/').pop()}</strong>
                <span>{selectedPath}</span>
              </div>
              <Button
                className="icon-button"
                shape="square"
                size="sm"
                variant="outline"
                onClick={onDownload}
                disabled={!canDownload}
                title="Download file"
                aria-label="Download file"
                icon={<Download size={15} />}
              />
            </header>
            {fileError ? <p className="file-error" role="alert">{fileError}</p> : (
              <pre className="code-viewer"><code>{fileContent}</code></pre>
            )}
          </>
        ) : (
          <div className="preview-placeholder">SELECT A FILE TO INSPECT</div>
        )}
      </div>
    </section>
  )
}
