import { nanoid } from 'nanoid'
import type { CanvasEdge, CanvasNode, TemplateRecord, WorkflowGraph } from './types.js'
import { defaultConfigForNode } from './node-registry.js'
import { nowIso } from './utils.js'

function node(nodeType: string, x: number, y: number, config: Record<string, unknown> = {}): CanvasNode {
  return { id: `node-${nanoid(8)}`, type: 'workflow', position: { x, y }, data: { nodeType, config: { ...defaultConfigForNode(nodeType), ...config }, status: 'idle' } }
}
function edge(source: CanvasNode, sourceHandle: string, target: CanvasNode, targetHandle: string): CanvasEdge {
  return { id: `edge-${nanoid(8)}`, source: source.id, target: target.id, sourceHandle, targetHandle }
}
function graph(name: string, description: string, nodes: CanvasNode[], edges: CanvasEdge[]): WorkflowGraph {
  const now = nowIso()
  return { schemaVersion: '2.0', id: 'main', revision: 0, name, description, mode: 'hybrid', nodes, edges, viewport: { x: 0, y: 0, zoom: 0.72 }, createdAt: now, updatedAt: now }
}

export function createStarterGraph(): WorkflowGraph {
  const brief = node('input.brief', 40, 80, { text: '为个人知识分享品牌设计一个辨识度高、适合头像与网页使用的视觉 IP。' })
  const prompt = node('agent.prompt-architect', 390, 80)
  const ratio = node('utility.aspect-ratio', 390, 360, { width: 1024, height: 1024 })
  const generate = node('image.generate', 760, 80, { candidateCount: 3, quality: 'high' })
  const review = node('review.quality', 1130, 80)
  const choose = node('control.human-select', 1460, 80)
  const output = node('output.canvas', 1790, 80, { markFinal: true })
  const note = node('canvas.note', 40, 430, { text: '自由画布元素只有被工作流连接时才参与执行。运行状态保存在 Run Snapshot，不会覆盖正在编辑的设计图。' })
  return graph('VibeCanvas 主画布', 'Agent 原生视觉创作与节点工作流示例。', [brief, prompt, ratio, generate, review, choose, output, note], [
    edge(brief, 'text', prompt, 'brief'), edge(prompt, 'promptSpec', generate, 'prompt'), edge(ratio, 'ratio', generate, 'size'),
    edge(generate, 'images', review, 'images'), edge(brief, 'text', review, 'brief'), edge(review, 'images', choose, 'images'), edge(choose, 'selected', output, 'image')
  ])
}

function createEditGraph(): WorkflowGraph {
  const source = node('input.image', 40, 80, { role: 'subject' })
  const annotation = node('input.annotation', 40, 430)
  const mask = node('input.mask', 390, 430)
  const brief = node('input.brief', 390, 80, { text: '根据批注和蒙版修改原图，保留未标注区域与主体身份。' })
  const prompt = node('agent.prompt-architect', 740, 80, { strategy: 'faithful' })
  const edit = node('image.edit', 1100, 80, { candidateCount: 2 })
  const review = node('review.quality', 1470, 80)
  const output = node('output.canvas', 1800, 80, { placement: 'right' })
  return graph('批注与蒙版图生图', '原图、批注、蒙版与 Image 2 编辑工作流。', [source, annotation, mask, brief, prompt, edit, review, output], [
    edge(brief, 'text', prompt, 'brief'), edge(source, 'image', prompt, 'references'), edge(prompt, 'promptSpec', edit, 'prompt'),
    edge(source, 'image', edit, 'source'), edge(annotation, 'annotation', edit, 'annotation'), edge(mask, 'mask', edit, 'mask'),
    edge(edit, 'images', review, 'images'), edge(brief, 'text', review, 'brief'), edge(review, 'selected', output, 'image')
  ])
}

export function createBuiltInTemplates(): TemplateRecord[] {
  const now = nowIso()
  return [
    { id: 'starter-image-workflow', name: '品牌视觉生成', description: '需求→Prompt→候选生成→Agent 评审→人工选择→输出。', category: 'generation', graph: createStarterGraph(), builtIn: true, createdAt: now, updatedAt: now },
    { id: 'annotation-mask-edit', name: '批注与蒙版编辑', description: '原图结合结构化批注和蒙版进行图生图修改。', category: 'editing', graph: createEditGraph(), builtIn: true, createdAt: now, updatedAt: now }
  ]
}
