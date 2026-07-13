import { useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { ArtifactRef, EvaluationReport, WorkflowRun } from '../../core/types.js'

export function CandidateSelector({ run, onClose, onSelect }: {
  run: WorkflowRun
  onClose: () => void
  onSelect: (nodeId: string, artifactId: string) => Promise<void>
}) {
  const entry = Object.values(run.nodeRuns).find((item) => item.status === 'needs-input')
  const candidates = (entry?.outputs?.candidates || []) as ArtifactRef[]
  const review = useMemo(() => Object.values(run.nodeRuns)
    .map((item) => item.outputs?.report as EvaluationReport | undefined)
    .find(Boolean), [run])
  const suggested = review && candidates[review.selectedIndex]?.id
  const [selected, setSelected] = useState<string>(suggested || candidates[0]?.id || '')
  const [saving, setSaving] = useState(false)
  const confirm = async () => {
    if (!entry || !selected) return
    setSaving(true)
    try { await onSelect(entry.nodeId, selected) } finally { setSaving(false) }
  }
  return (
    <div className="modal-backdrop">
      <section className="modal-card candidate-modal">
        <header><div><strong>候选图片选择器</strong><small>先预选并放大比较，确认后 Run 才会继续。</small></div><button onClick={onClose}><X /></button></header>
        {review ? <div className="candidate-review"><strong>评审建议：候选 {review.selectedIndex + 1}</strong><span>{review.reviewer || 'technical'} · {review.score} 分 · {review.decision}</span>{review.issues?.length ? <small>{review.issues.map((issue) => issue.message).join(' · ')}</small> : null}</div> : null}
        <div className="candidate-grid">
          {candidates.map((artifact, index) => (
            <button className={`candidate-card ${selected === artifact.id ? 'selected' : ''}`} key={artifact.id} onClick={() => setSelected(artifact.id)}>
              <img src={artifact.url} alt={artifact.fileName} />
              <span>{selected === artifact.id ? <Check size={15} /> : null}候选 {index + 1}</span>
              <small>{artifact.width ?? '?'}×{artifact.height ?? '?'} · {artifact.status}</small>
            </button>
          ))}
        </div>
        {!candidates.length ? <p>该暂停节点没有返回候选图片。</p> : null}
        <footer><button onClick={onClose}>取消</button><button className="primary" disabled={!selected || saving} onClick={() => void confirm()}><Check size={15} />{saving ? '提交中…' : '确认选择并继续'}</button></footer>
      </section>
    </div>
  )
}
