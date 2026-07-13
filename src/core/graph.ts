import type { CanvasEdge, CanvasNode, GraphPatch, ValidationProblem, ValidationResult, WorkflowGraph } from './types.js'
import { getNodeDefinition } from './node-registry.js'
import { graphPatchSchema, workflowGraphSchema } from './schemas.js'
import { nowIso } from './utils.js'
import { arePortTypesCompatible } from './port-types.js'

export function validateGraph(graph: WorkflowGraph): ValidationResult {
  const parsed = workflowGraphSchema.safeParse(graph)
  if (!parsed.success) {
    return {
      valid: false,
      problems: parsed.error.issues.map((issue) => ({ code: 'schema', severity: 'error', message: `${issue.path.join('.')}: ${issue.message}` })),
      executionOrder: []
    }
  }

  const problems: ValidationProblem[] = []
  const nodeMap = new Map<string, CanvasNode>()
  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) problems.push({ code: 'duplicate-node', severity: 'error', nodeId: node.id, message: `重复节点 ID：${node.id}` })
    nodeMap.set(node.id, node)
    if (!getNodeDefinition(node.data.nodeType)) problems.push({ code: 'unknown-node-type', severity: 'error', nodeId: node.id, message: `未知节点类型：${node.data.nodeType}` })
    if (node.parentId && !graph.nodes.some((parent) => parent.id === node.parentId)) problems.push({ code: 'missing-parent', severity: 'error', nodeId: node.id, message: `子工作流父节点不存在：${node.parentId}` })
  }

  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) problems.push({ code: 'duplicate-edge', severity: 'error', edgeId: edge.id, message: `重复连接 ID：${edge.id}` })
    edgeIds.add(edge.id)
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) {
      problems.push({ code: 'dangling-edge', severity: 'error', edgeId: edge.id, message: `连接引用了不存在的节点：${edge.id}` })
      continue
    }
    if (source.id === target.id) {
      problems.push({ code: 'self-edge', severity: 'error', edgeId: edge.id, message: '节点不能连接到自身。' })
      continue
    }
    const sourceDef = getNodeDefinition(source.data.nodeType)
    const targetDef = getNodeDefinition(target.data.nodeType)
    const sourcePort = sourceDef?.outputs.find((port) => port.id === edge.sourceHandle)
    const targetPort = targetDef?.inputs.find((port) => port.id === edge.targetHandle)
    if (!sourcePort) problems.push({ code: 'unknown-source-port', severity: 'error', edgeId: edge.id, message: `源端口不存在：${edge.sourceHandle}` })
    if (!targetPort) problems.push({ code: 'unknown-target-port', severity: 'error', edgeId: edge.id, message: `目标端口不存在：${edge.targetHandle}` })
    if (sourcePort && targetPort && !arePortTypesCompatible(sourcePort.type, targetPort.type)) {
      problems.push({ code: 'type-mismatch', severity: 'error', edgeId: edge.id, message: `端口类型不兼容：${sourcePort.type} → ${targetPort.type}` })
    }
  }

  for (const node of graph.nodes) {
    const definition = getNodeDefinition(node.data.nodeType)
    if (!definition) continue
    for (const input of definition.inputs.filter((port) => port.required)) {
      const connected = graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === input.id)
      if (!connected && !hasConfigFallback(node, input.id) && !node.data.freeform) {
        problems.push({ code: 'missing-required-input', severity: 'warning', nodeId: node.id, message: `${definition.label} 缺少必需输入：${input.label}` })
      }
    }
    for (const input of definition.inputs.filter((port) => !port.multiple)) {
      const count = graph.edges.filter((edge) => edge.target === node.id && edge.targetHandle === input.id).length
      if (count > 1) problems.push({ code: 'multiple-to-single', severity: 'error', nodeId: node.id, message: `${definition.label} 的 ${input.label} 仅允许一个输入。` })
    }
  }

  const executionOrder = topologicalSort(graph.nodes, graph.edges)
  if (executionOrder.length !== graph.nodes.length) problems.push({ code: 'cycle', severity: 'error', message: '工作流存在循环连接。请使用受控重试节点，而不是直接形成图环。' })
  return { valid: !problems.some((problem) => problem.severity === 'error'), problems, executionOrder }
}

function hasConfigFallback(node: CanvasNode, inputId: string): boolean {
  if ((node.data.nodeType === 'input.image' || node.data.nodeType === 'canvas.image') && ['image', 'imageIn'].includes(inputId)) return Boolean(node.data.config.artifactId)
  if (node.data.nodeType === 'input.mask' && inputId === 'mask') return Boolean(node.data.config.artifactId)
  if (node.data.nodeType === 'input.annotation' && inputId === 'annotation') return Boolean(node.data.config.artifactId)
  return false
}

export function topologicalSort(nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  }
  const queue = [...nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)]
  const result: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const target of outgoing.get(id) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 1) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  return result
}

export function ancestorsForTarget(graph: WorkflowGraph, targetNodeId: string): Set<string> {
  if (!graph.nodes.some((node) => node.id === targetNodeId)) throw new Error(`Target node not found: ${targetNodeId}`)
  const required = new Set<string>([targetNodeId])
  let changed = true
  while (changed) {
    changed = false
    for (const edge of graph.edges) {
      if (required.has(edge.target) && !required.has(edge.source)) {
        required.add(edge.source)
        changed = true
      }
    }
  }
  return required
}

export function executionNodeIds(graph: WorkflowGraph, targetNodeId?: string): Set<string> {
  if (targetNodeId) return ancestorsForTarget(graph, targetNodeId)
  const outputRoots = graph.nodes.filter((node) => getNodeDefinition(node.data.nodeType)?.category === 'output')
  if (outputRoots.length) {
    const ids = new Set<string>()
    for (const root of outputRoots) for (const id of ancestorsForTarget(graph, root.id)) ids.add(id)
    return ids
  }
  const connected = new Set(graph.edges.flatMap((edge) => [edge.source, edge.target]))
  return new Set(graph.nodes.filter((node) => connected.has(node.id) && !node.data.freeform).map((node) => node.id))
}

export function applyGraphPatch(graph: WorkflowGraph, patch: GraphPatch): WorkflowGraph {
  const parsedPatch = graphPatchSchema.parse(patch) as GraphPatch
  if (parsedPatch.baseRevision !== graph.revision) throw new RevisionConflictError(graph.revision, parsedPatch.baseRevision)
  const next: WorkflowGraph = structuredClone(graph)
  for (const operation of parsedPatch.operations) {
    switch (operation.op) {
      case 'addNode':
        if (next.nodes.some((node) => node.id === operation.node.id)) throw new Error(`Node already exists: ${operation.node.id}`)
        next.nodes.push(operation.node)
        break
      case 'updateNode': {
        const node = requireNode(next, operation.nodeId)
        node.data = { ...node.data, ...operation.patch, config: operation.patch.config ? { ...node.data.config, ...(operation.patch.config as Record<string, unknown>) } : node.data.config }
        break
      }
      case 'moveNode':
        requireNode(next, operation.nodeId).position = operation.position
        break
      case 'resizeNode': {
        const node = requireNode(next, operation.nodeId)
        node.width = operation.width
        node.height = operation.height
        break
      }
      case 'removeNode':
        next.nodes = next.nodes.filter((node) => node.id !== operation.nodeId && node.parentId !== operation.nodeId)
        next.edges = next.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId)
        break
      case 'connect':
        if (next.edges.some((edge) => edge.id === operation.edge.id)) throw new Error(`Edge already exists: ${operation.edge.id}`)
        next.edges.push(operation.edge)
        break
      case 'disconnect':
        next.edges = next.edges.filter((edge) => edge.id !== operation.edgeId)
        break
      case 'setMode': next.mode = operation.mode; break
      case 'setViewport': next.viewport = operation.viewport; break
      case 'setGraphMetadata':
        if (operation.name) next.name = operation.name
        if (operation.description !== undefined) next.description = operation.description
        break
    }
  }
  next.schemaVersion = '2.0'
  next.updatedAt = nowIso()
  const parsed = workflowGraphSchema.parse(next) as WorkflowGraph
  const validation = validateGraph(parsed)
  if (!validation.valid) throw new Error(validation.problems.filter((problem) => problem.severity === 'error').map((problem) => problem.message).join('；'))
  return parsed
}

function requireNode(graph: WorkflowGraph, nodeId: string): CanvasNode {
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (!node) throw new Error(`Node not found: ${nodeId}`)
  return node
}

export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT'
  constructor(readonly currentRevision: number, readonly suppliedRevision: number) {
    super(`Graph revision conflict: current=${currentRevision}, supplied=${suppliedRevision}`)
  }
}
