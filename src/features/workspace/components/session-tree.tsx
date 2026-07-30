import { Button } from '@cloudflare/kumo/components/button'
import { GitBranch, GitFork, Scissors, Tag } from 'lucide-react'
import type { SessionOverview } from '../../../shared/pi-contract'

type SessionTreeProps = {
  compacting: boolean
  hidden: boolean
  overview: SessionOverview | null
  pending: boolean
  onCompact: () => void
  onFork: (entryId: string) => void
  onLabel: (entryId: string, label?: string) => void
  onNavigate: (entryId: string) => void
}

export function SessionTree({ compacting, hidden, overview, pending, onCompact, onFork, onLabel, onNavigate }: SessionTreeProps) {
  const nodes = overview?.tree ?? []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depth = (id: string) => {
    let value = 0
    let parentId = byId.get(id)?.parentId
    while (parentId && value < 12) {
      value += 1
      parentId = byId.get(parentId)?.parentId
    }
    return value
  }

  return (
    <section id="tree-panel" className={`workspace-panel tree-panel ${hidden ? 'panel-hidden' : ''}`} role="tabpanel" aria-label="TREE">
      <header className="workspace-header">
        <div><span className="panel-kicker">REVISION {overview?.revision ?? 0}</span><strong>SESSION TREE</strong></div>
        <span className="branch-key"><i /> ACTIVE BRANCH</span>
      </header>
      <div className="tree-list" aria-label="Session entries">
        {!overview && <p className="file-state">LOADING BRANCH MAP...</p>}
        {overview && nodes.length === 0 && <div className="file-empty"><GitBranch size={28} strokeWidth={1.5} /><strong>EMPTY TREE</strong><span>Send a prompt to establish a branch.</span></div>}
        {nodes.map((node) => (
          <article className={`tree-node ${node.isOnActiveBranch ? 'active' : ''}`} key={node.id} style={{ '--tree-depth': Math.min(depth(node.id), 6) } as React.CSSProperties}>
            <button className="tree-node-main" onClick={() => onNavigate(node.id)} disabled={pending} aria-current={node.id === overview?.activeLeafId ? 'true' : undefined}>
              <span className="tree-rail" aria-hidden="true" />
              <span className="tree-meta">{node.seq.toString().padStart(3, '0')} / {node.role?.toUpperCase() || node.type.toUpperCase()}</span>
              <strong>{node.label || node.preview || node.type.replaceAll('_', ' ')}</strong>
              <small>{node.id}{node.isLeaf ? ' / LEAF' : ''}</small>
            </button>
            <div className="tree-actions">
              <Button shape="square" size="sm" variant="ghost" aria-label={`Label entry ${node.id}`} title="Set label" disabled={pending} onClick={() => { const label = window.prompt('Entry label', node.label ?? ''); if (label !== null) onLabel(node.id, label.trim() || undefined) }} icon={<Tag size={13} />} />
              {node.type === 'message' && node.role === 'user' && <Button shape="square" size="sm" variant="ghost" aria-label={`Fork from entry ${node.id}`} title="Fork from here" disabled={pending} onClick={() => onFork(node.id)} icon={<GitFork size={13} />} />}
            </div>
          </article>
        ))}
      </div>
      <footer className="tree-footer">
        <Button variant="ghost" aria-label="Compact session" disabled={pending} onClick={onCompact}><Scissors size={12} /> {compacting ? 'COMPACTING' : 'COMPACT'}</Button>
        <div><span>{nodes.filter((node) => node.isOnActiveBranch).length} ACTIVE</span><span>{nodes.filter((node) => node.isLeaf).length} LEAVES</span></div>
      </footer>
    </section>
  )
}
