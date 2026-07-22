/**
 * 隐藏的 image.edit 子图编排。
 *
 * 设计目标:
 * - 让前端能在不暴露工作流节点的前提下,驱动 image.edit 完成按箭头修改。
 * - 不复用文生图流程的 input.brief / agent.prompt-architect,避免编辑 prompt 污染生成流程。
 * - 创建与复用都产出可被 applyGraphPatch 原子提交的 operations 列表。
 * - 复用时只更新 config,不重复创建节点或边。
 *
 * 子图拓扑:
 *   input.brief   ─→ agent.prompt-architect.brief
 *   input.image   ─→ agent.prompt-architect.references
 *   input.image   ─→ image.edit.source
 *   input.annotation ─→ image.edit.annotation
 *   agent.prompt-architect ─→ image.edit.prompt
 */

import type { CanvasEdge, CanvasNode, GraphPatchOperation, WorkflowGraph } from '../../core/types.js'
import { defaultConfigForNode } from '../../core/node-registry.js'

/** 内部用途标记,放在节点 config 里用于识别这套隐藏子图。 */
export const EDIT_WORKFLOW_MARKER = '__vibecanvasEditWorkflow'

/** 隐藏子图中各节点类型到节点 ID 的映射。 */
export interface EditWorkflowNodeIds {
  brief: string
  source: string
  annotation: string
  architect: string
  edit: string
}

export interface EnsureEditWorkflowInput {
  sourceArtifactId: string
  annotationArtifactId: string
  /** 已经拼好的 brief 文本,会写入 input.brief 并传入 architect。 */
  brief: string
  quality: string
  candidateCount: number
  /** 可选的自定义 ID 生成器,测试时可注入确定性序列。 */
  idFactory?: () => string
}

export interface EnsureEditWorkflowResult {
  /** 本次是否新建了隐藏子图;false 表示复用了已有的。 */
  created: boolean
  nodeIds: EditWorkflowNodeIds
  /** 可直接放入 applyGraphPatch 的 operations。 */
  operations: GraphPatchOperation[]
}

const INTERNAL_PURPOSE = 'hidden-edit-workflow'

/**
 * 在给定 graph 上查找现有的隐藏 edit 子图节点。
 * 通过 config 中的 EDIT_WORKFLOW_MARKER 标记识别,而不是依赖外部 ID 约定。
 */
export function findEditWorkflowNodes(graph: WorkflowGraph): EditWorkflowNodeIds | undefined {
  const marked = graph.nodes.filter((node) => Boolean(node.data.config[EDIT_WORKFLOW_MARKER]))
  if (marked.length === 0) return undefined
  const findByType = (nodeType: string): string | undefined => marked.find((node) => node.data.nodeType === nodeType)?.id
  const brief = findByType('input.brief')
  const source = findByType('input.image')
  const annotation = findByType('input.annotation')
  const architect = findByType('agent.prompt-architect')
  const edit = findByType('image.edit')
  if (!brief || !source || !annotation || !architect || !edit) return undefined
  return { brief, source, annotation, architect, edit }
}

/**
 * 构造首次创建隐藏 edit 子图的 operations。
 * 一次性产出全部节点和边,保证 patch 提交后 graph 合法。
 */
function buildCreationOperations(input: EnsureEditWorkflowInput, idFactory: () => string): { nodeIds: EditWorkflowNodeIds; operations: GraphPatchOperation[] } {
  const nodeIds: EditWorkflowNodeIds = {
    brief: idFactory(),
    source: idFactory(),
    annotation: idFactory(),
    architect: idFactory(),
    edit: idFactory()
  }

  const createNode = (nodeType: string, id: string, config: Record<string, unknown>): CanvasNode => ({
    id,
    type: 'workflow',
    position: { x: -4000, y: -4000 },
    data: {
      nodeType,
      config: {
        ...defaultConfigForNode(nodeType),
        ...config,
        [EDIT_WORKFLOW_MARKER]: true,
        __purpose: INTERNAL_PURPOSE
      },
      status: 'idle',
      freeform: false
    }
  })

  const createEdge = (source: string, sourceHandle: string, target: string, targetHandle: string): CanvasEdge => ({
    id: idFactory(),
    source,
    target,
    sourceHandle,
    targetHandle
  })

  const nodes: CanvasNode[] = [
    createNode('input.brief', nodeIds.brief, { text: input.brief }),
    createNode('input.image', nodeIds.source, { artifactId: input.sourceArtifactId, role: 'subject' }),
    createNode('input.annotation', nodeIds.annotation, { artifactId: input.annotationArtifactId, text: '' }),
    createNode('agent.prompt-architect', nodeIds.architect, { strategy: 'faithful', llmEnabled: true }),
    createNode('image.edit', nodeIds.edit, {
      quality: input.quality,
      candidateCount: input.candidateCount,
      annotationInstruction: '严格按批注箭头和标签修改指定区域,未标注区域尽量保持原样。最终图不得保留箭头、标签、选框或任何编辑器痕迹。'
    })
  ]

  const edges: CanvasEdge[] = [
    createEdge(nodeIds.brief, 'text', nodeIds.architect, 'brief'),
    createEdge(nodeIds.source, 'image', nodeIds.architect, 'references'),
    createEdge(nodeIds.source, 'image', nodeIds.edit, 'source'),
    createEdge(nodeIds.annotation, 'annotation', nodeIds.edit, 'annotation'),
    createEdge(nodeIds.architect, 'promptSpec', nodeIds.edit, 'prompt')
  ]

  return {
    nodeIds,
    operations: [
      ...nodes.map((node) => ({ op: 'addNode' as const, node })),
      ...edges.map((edge) => ({ op: 'connect' as const, edge }))
    ]
  }
}

/**
 * 构造更新已有隐藏 edit 子图输入的 operations。
 * 只更新 4 个节点的 config,不触碰节点和边结构。
 */
function buildUpdateOperations(nodeIds: EditWorkflowNodeIds, input: EnsureEditWorkflowInput): GraphPatchOperation[] {
  return [
    { op: 'updateNode', nodeId: nodeIds.brief, patch: { config: { text: input.brief } } },
    { op: 'updateNode', nodeId: nodeIds.source, patch: { config: { artifactId: input.sourceArtifactId } } },
    { op: 'updateNode', nodeId: nodeIds.annotation, patch: { config: { artifactId: input.annotationArtifactId } } },
    { op: 'updateNode', nodeId: nodeIds.edit, patch: { config: { quality: input.quality, candidateCount: input.candidateCount } } }
  ]
}

/**
 * 在 graph 上查找或创建隐藏 edit 子图,返回可直接提交的 operations。
 *
 * 调用方负责:
 * 1. 用当前 graph.revision 作为 baseRevision 提交返回的 operations。
 * 2. 提交成功后用返回的 nodeIds.edit 作为 run target。
 */
export function ensureImageEditWorkflow(graph: WorkflowGraph, input: EnsureEditWorkflowInput): EnsureEditWorkflowResult {
  const idFactory = input.idFactory ?? (() => `node-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`)
  const existing = findEditWorkflowNodes(graph)
  if (existing) {
    return {
      created: false,
      nodeIds: existing,
      operations: buildUpdateOperations(existing, input)
    }
  }
  const { nodeIds, operations } = buildCreationOperations(input, idFactory)
  return { created: true, nodeIds, operations }
}
