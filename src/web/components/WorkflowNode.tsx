import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { Bot, Boxes, CheckCircle2, Circle, FileImage, ImageIcon, ImagePlus, LoaderCircle, MessageSquareText, Sparkles, TriangleAlert } from 'lucide-react'
import type { CanvasNodeData } from '../../core/types.js'
import { getNodeDefinition } from '../../core/node-registry.js'

const categoryIcons = {
  input: MessageSquareText,
  agent: Bot,
  generation: Sparkles,
  processing: Circle,
  control: CheckCircle2,
  output: FileImage,
  canvas: ImageIcon,
  workflow: Boxes
}

export function WorkflowNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as CanvasNodeData
  const definition = getNodeDefinition(nodeData.nodeType)
  const Icon = categoryIcons[definition?.category ?? 'canvas']
  const previewId = nodeData.previewArtifactId || String(nodeData.config.artifactId || '')
  const isCanvasNode = definition?.category === 'canvas'
  const isEmptyPlaceholder = nodeData.nodeType === 'canvas.image' && !previewId
  const statusIcon = nodeData.status === 'running'
    ? <LoaderCircle size={14} className="spin" />
    : nodeData.status === 'failed'
      ? <TriangleAlert size={14} />
      : nodeData.status === 'completed' || nodeData.status === 'cached'
        ? <CheckCircle2 size={14} />
        : <Circle size={11} />

  // Empty AI image placeholder: dashed border + hint text, no ports.
  if (isEmptyPlaceholder) {
    return (
      <div className={`ai-placeholder ${selected ? 'selected' : ''}`}>
        <NodeResizer minWidth={200} minHeight={200} isVisible={selected} />
        <ImagePlus size={28} />
        <span className="placeholder-label">AI 图片框</span>
        <span className="placeholder-hint">选中后在左侧写 prompt 生成</span>
      </div>
    )
  }

  // Canvas nodes (note/annotation/image-with-content): render without workflow ports.
  if (isCanvasNode) {
    return (
      <div className={`workflow-node category-canvas status-${nodeData.status ?? 'idle'} ${selected ? 'selected' : ''}`}>
        <NodeResizer minWidth={200} minHeight={120} isVisible={selected} />
        <div className="node-header">
          <span className="node-icon"><Icon size={16} /></span>
          <div className="node-heading">
            <strong>{nodeData.label || definition?.label || nodeData.nodeType}</strong>
          </div>
          <span className="node-status" title={nodeData.statusMessage}>{statusIcon}</span>
        </div>
        {previewId ? (
          <div className="node-preview"><img src={`/api/artifacts/${previewId}/file`} alt="节点图片预览" /></div>
        ) : (
          <div className="node-content">
            <p>{previewText(nodeData)}</p>
          </div>
        )}
        {nodeData.statusMessage ? <div className="node-message">{nodeData.statusMessage}</div> : null}
      </div>
    )
  }

  // Workflow nodes (hidden from canvas by filtering, but keep renderer for safety).
  return (
    <div className={`workflow-node category-${definition?.category ?? 'canvas'} status-${nodeData.status ?? 'idle'} ${selected ? 'selected' : ''}`}>
      <NodeResizer minWidth={220} minHeight={120} isVisible={selected} />
      {definition?.inputs.map((port, index) => (
        <Handle key={port.id} id={port.id} type="target" position={Position.Left} style={{ top: 66 + index * 28 }} title={`${port.label}: ${port.type}`} />
      ))}
      <div className="node-header">
        <span className="node-icon"><Icon size={16} /></span>
        <div className="node-heading">
          <strong>{nodeData.label || definition?.label || nodeData.nodeType}</strong>
          <small>{definition?.category}</small>
        </div>
        <span className="node-status" title={nodeData.statusMessage}>{statusIcon}</span>
      </div>
      {previewId ? (
        <div className="node-preview"><img src={`/api/artifacts/${previewId}/file`} alt="节点图片预览" /></div>
      ) : (
        <div className="node-content">
          <p>{previewText(nodeData)}</p>
          {definition?.inputs.length ? <span>{definition.inputs.length} 输入</span> : null}
          {definition?.outputs.length ? <span>{definition.outputs.length} 输出</span> : null}
        </div>
      )}
      {nodeData.statusMessage ? <div className="node-message">{nodeData.statusMessage}</div> : null}
      {definition?.outputs.map((port, index) => (
        <Handle key={port.id} id={port.id} type="source" position={Position.Right} style={{ top: 66 + index * 28 }} title={`${port.label}: ${port.type}`} />
      ))}
    </div>
  )
}

function previewText(data: CanvasNodeData): string {
  if (typeof data.config.text === 'string' && data.config.text) return data.config.text.slice(0, 150)
  if (data.nodeType === 'utility.aspect-ratio') return `${data.config.width ?? 1024} × ${data.config.height ?? 1024}`
  if (data.nodeType.startsWith('image.')) return `质量：${data.config.quality ?? 'high'} · 候选：${data.config.candidateCount ?? 1}`
  return getNodeDefinition(data.nodeType)?.description ?? 'VibeCanvas 节点'
}
