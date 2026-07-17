import { GitBranch, ImageDown, Play, Save, Scissors, Upload } from 'lucide-react'
import type { ArtifactRef, CanvasNode, ConfigFieldDefinition, NodeDefinition } from '../../core/types.js'

interface Props {
  node?: CanvasNode
  definition?: NodeDefinition
  artifacts: ArtifactRef[]
  onChange: (patch: Record<string, unknown>) => void
  onRun: () => void
  onUpload: (file: File, role?: string) => Promise<void>
  onOpenEditor: (mode: 'annotation' | 'mask') => void
  onLineage: (artifact: ArtifactRef) => void
  onPlaceArtifact: (artifact: ArtifactRef) => void
}

export function Inspector({ node, definition, artifacts, onChange, onRun, onUpload, onOpenEditor, onLineage, onPlaceArtifact }: Props) {
  const selectedArtifact = node?.data.config.artifactId ? artifacts.find((item) => item.id === node.data.config.artifactId) : undefined
  if (!node || !definition) {
    return <aside className="inspector panel-shell"><div className="panel-title"><Save size={17} /><span>属性与素材</span></div><div className="empty-state">选择一个节点，在这里编辑参数、上传参考图、批注或运行到该节点。</div><ArtifactList artifacts={artifacts} onLineage={onLineage} onPlace={onPlaceArtifact} /></aside>
  }
  return <aside className="inspector panel-shell">
    <div className="panel-title"><Save size={17} /><span>{definition.label}</span></div><p className="panel-help">{definition.description}</p>
    <div className="inspector-actions"><button onClick={onRun}><Play size={14} />运行到此</button></div>
    {selectedArtifact && ['canvas.image','input.image'].includes(node.data.nodeType) ? <div className="inspector-actions editor-actions"><button onClick={() => onOpenEditor('annotation')}><ImageDown size={14} />批注</button><button onClick={() => onOpenEditor('mask')}><Scissors size={14} />Mask</button><button onClick={() => onLineage(selectedArtifact)}><GitBranch size={14} />版本树</button></div> : null}
    <div className="field-list">{definition.configFields.map((field) => <ConfigField key={field.key} field={field} value={node.data.config[field.key]} onChange={(value) => onChange({ [field.key]: value })} onUpload={onUpload} />)}</div>
    {node.data.outputs ? <details className="json-details"><summary>最近设计态输出</summary><pre>{JSON.stringify(node.data.outputs, null, 2)}</pre></details> : null}
    <ArtifactList artifacts={artifacts} onLineage={onLineage} onPlace={onPlaceArtifact} />
  </aside>
}

function ConfigField({ field, value, onChange, onUpload }: { field: ConfigFieldDefinition; value: unknown; onChange: (value: unknown) => void; onUpload: (file: File, role?: string) => Promise<void> }) {
  const id = `field-${field.key}`
  if (field.type === 'textarea') return <label htmlFor={id}><span>{field.label}</span><textarea id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} rows={5} /></label>
  if (field.type === 'number') return <label htmlFor={id}><span>{field.label}</span><input id={id} type="number" value={Number(value ?? field.default ?? 0)} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(Number(event.target.value))} /></label>
  if (field.type === 'boolean') return <label className="toggle-field" htmlFor={id}><span>{field.label}</span><input id={id} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /></label>
  if (field.type === 'select') return <label htmlFor={id}><span>{field.label}</span><select id={id} value={String(value ?? field.default ?? '')} onChange={(event) => onChange(event.target.value)}>{field.options?.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select></label>
  if (field.type === 'json') return <label htmlFor={id}><span>{field.label}</span><textarea id={id} value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)} onChange={(event) => { try { onChange(JSON.parse(event.target.value)) } catch { onChange(event.target.value) } }} rows={6} /></label>
  if (field.type === 'image') return <label className="upload-field"><span>{field.label}</span><input type="file" accept="image/*" onChange={async (event) => { const file = event.target.files?.[0]; if (file) await onUpload(file) }} /><span className="upload-button"><Upload size={14} />上传图片</span>{value ? <small>Artifact: {String(value)}</small> : null}</label>
  return <label htmlFor={id}><span>{field.label}</span><input id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /></label>
}

function ArtifactList({ artifacts, onLineage, onPlace }: { artifacts: ArtifactRef[]; onLineage: (artifact: ArtifactRef) => void; onPlace: (artifact: ArtifactRef) => void }) {
  return <section className="artifact-section"><h3>素材库</h3><div className="artifact-grid">{artifacts.slice().reverse().slice(0, 20).map((artifact) => <article key={artifact.id} title={`${artifact.fileName}\n${artifact.width ?? '?'}×${artifact.height ?? '?'}\n${artifact.status}`}><img src={artifact.url} alt={artifact.fileName} /><div><button onClick={() => onPlace(artifact)}>放置</button><button onClick={() => onLineage(artifact)}>版本</button></div></article>)}{!artifacts.length ? <small>还没有上传或生成图片。</small> : null}</div></section>
}
