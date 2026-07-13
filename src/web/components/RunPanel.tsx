import { Ban, Play, X } from 'lucide-react'
import type { WorkflowRun } from '../../core/types.js'

export function RunPanel({ runs, onClose, onCancel, onChoose }: { runs: WorkflowRun[]; onClose: () => void; onCancel: (id: string) => Promise<void>; onChoose: (run: WorkflowRun) => void }) {
  return <div className="modal-backdrop"><section className="modal-card run-modal"><header><div><strong>运行与费用面板</strong><small>异步队列、节点状态、估算费用与崩溃恢复记录。</small></div><button onClick={onClose}><X /></button></header>
    <div className="run-list">{runs.map((run) => <article key={run.id} className={`run-row status-${run.status}`}><div><strong>{run.id}</strong><span>{run.status} · graph r{run.graphRevision} · 尝试 {run.attempts}/{run.maxAttempts}</span><small>估算 ${run.estimatedCostUsd.toFixed(4)} · 实际 ${run.actualCostUsd.toFixed(4)} · {Object.keys(run.nodeRuns).length} 节点</small>{run.error ? <em>{run.error}</em> : null}</div><div>{run.status === 'needs-input' ? <button className="primary" onClick={() => onChoose(run)}><Play size={14} />选择候选</button> : null}{['queued','running'].includes(run.status) ? <button onClick={() => void onCancel(run.id)}><Ban size={14} />取消</button> : null}</div></article>)}</div>
  </section></div>
}
