import { useState } from 'react'
import { ImagePlus, Loader2, Sparkles, SquareDashed, X } from 'lucide-react'
import type { ArtifactRef, CanvasNode } from '../../core/types.js'

export interface GenerateConfig {
  width: number
  height: number
  quality: string
  candidateCount: number
}

interface Props {
  selectedNode?: CanvasNode
  artifacts: ArtifactRef[]
  isGenerating: boolean
  generateProgress: string
  candidates: ArtifactRef[]
  onAddPlaceholder: () => void
  onGenerate: (nodeId: string, prompt: string, config: GenerateConfig) => void
  onSelectCandidate: (artifactId: string) => void
  onCancelGenerate: () => void
}

const SIZES = [
  { label: '1024 × 1024（方形）', width: 1024, height: 1024 },
  { label: '1536 × 1024（横向）', width: 1536, height: 1024 },
  { label: '1024 × 1536（竖向）', width: 1024, height: 1536 },
  { label: '2048 × 2048（高分辨率）', width: 2048, height: 2048 }
]

export function CreatePanel({ selectedNode, isGenerating, generateProgress, candidates, onAddPlaceholder, onGenerate, onSelectCandidate, onCancelGenerate }: Props) {
  const [prompt, setPrompt] = useState('')
  const [sizeIndex, setSizeIndex] = useState(0)
  const [quality, setQuality] = useState('medium')
  const [candidateCount, setCandidateCount] = useState(1)

  const isSelectedPlaceholder = selectedNode?.data.nodeType === 'canvas.image'
  const hasImage = Boolean(selectedNode?.data.config.artifactId)

  const handleGenerate = () => {
    if (!selectedNode || !prompt.trim()) return
    const size = SIZES[sizeIndex]
    onGenerate(selectedNode.id, prompt.trim(), { width: size.width, height: size.height, quality, candidateCount })
  }

  const handleSelectCandidate = (artifactId: string) => {
    onSelectCandidate(artifactId)
  }

  return (
    <aside className="create-panel panel-shell">
      <div className="panel-title"><Sparkles size={17} /><span>创作</span></div>

      <div className="create-body">
        <button className="add-placeholder-btn" onClick={onAddPlaceholder}>
          <ImagePlus size={16} /> 添加 AI 图片框
        </button>

        {isGenerating ? (
          <section className="create-section">
            <div className="generating-state">
              <Loader2 size={20} className="spin" />
              <span>{generateProgress || '正在生成…'}</span>
            </div>
            <button className="cancel-btn" onClick={onCancelGenerate}><X size={13} /> 取消</button>
          </section>
        ) : candidates.length > 0 ? (
          <section className="create-section">
            <h4>选择一张候选</h4>
            <div className="candidate-grid">
              {candidates.map((artifact) => (
                <button key={artifact.id} className="candidate-item" onClick={() => handleSelectCandidate(artifact.id)}>
                  <img src={`/api/artifacts/${artifact.id}/file`} alt={artifact.fileName} />
                </button>
              ))}
            </div>
          </section>
        ) : isSelectedPlaceholder ? (
          <section className="create-section">
            <h4>{hasImage ? '重新生成' : '生成图片'}</h4>
            <label className="create-field">
              <span>Prompt</span>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想生成的图片…" rows={5} />
            </label>
            <label className="create-field">
              <span>尺寸</span>
              <select value={sizeIndex} onChange={(e) => setSizeIndex(Number(e.target.value))}>
                {SIZES.map((size, i) => <option key={i} value={i}>{size.label}</option>)}
              </select>
            </label>
            <label className="create-field">
              <span>质量</span>
              <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                <option value="low">Low（快速草稿）</option>
                <option value="medium">Medium（平衡）</option>
                <option value="high">High（精细）</option>
              </select>
            </label>
            <label className="create-field">
              <span>候选数量</span>
              <select value={candidateCount} onChange={(e) => setCandidateCount(Number(e.target.value))}>
                <option value={1}>1 张</option>
                <option value={2}>2 张</option>
                <option value={3}>3 张</option>
                <option value={4}>4 张</option>
              </select>
            </label>
            <button className="generate-btn" onClick={handleGenerate} disabled={!prompt.trim()}>
              <Sparkles size={15} /> 生成
            </button>
          </section>
        ) : (
          <p className="create-hint">
            <SquareDashed size={28} />
            点击上方按钮添加一个 AI 图片框，选中它后在这里写 prompt 生成图片。
          </p>
        )}
      </div>
    </aside>
  )
}
