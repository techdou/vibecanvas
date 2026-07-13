import { X } from 'lucide-react'
import type { ArtifactLineage, ArtifactRef } from '../../core/types.js'

export function ArtifactLineagePanel({ lineage, onClose, onStatus }: { lineage: ArtifactLineage; onClose: () => void; onStatus: (artifact: ArtifactRef, status: ArtifactRef['status']) => Promise<void> }) {
  const row = (artifact: ArtifactRef, label: string) => <article className="lineage-item" key={`${label}-${artifact.id}`}><img src={artifact.url} alt={artifact.fileName} /><div><strong>{label}</strong><span>{artifact.fileName}</span><small>{artifact.status} · {artifact.width ?? '?'}×{artifact.height ?? '?'}</small></div></article>
  return <div className="modal-backdrop"><section className="modal-card lineage-modal"><header><div><strong>Artifact 版本树</strong><small>查看父版本、当前版本和后续分支。</small></div><button onClick={onClose}><X /></button></header>
    <div className="lineage-current">{row(lineage.artifact, '当前版本')}<div className="status-actions">{(['draft','candidate','selected','final','archived'] as const).map((status) => <button key={status} className={lineage.artifact.status === status ? 'active' : ''} onClick={() => void onStatus(lineage.artifact, status)}>{status}</button>)}</div></div>
    <h3>上游版本</h3><div className="lineage-list">{lineage.ancestors.map((item) => row(item, '父版本'))}{!lineage.ancestors.length ? <small>没有上游版本。</small> : null}</div>
    <h3>后续分支</h3><div className="lineage-list">{lineage.descendants.map((item) => row(item, '子版本'))}{!lineage.descendants.length ? <small>没有后续分支。</small> : null}</div>
  </section></div>
}
