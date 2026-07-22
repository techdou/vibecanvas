import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow,
  ReactFlowProvider, type Connection, type EdgeChange, type NodeChange, type OnSelectionChangeParams, type ReactFlowInstance, type Viewport
} from '@xyflow/react'
import { CheckCircle2, CircleAlert, History, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RotateCcw, Settings2, Workflow } from 'lucide-react'
import type {
  ArtifactLineage, ArtifactRef, CanvasEdge, CanvasNode, GraphPatchOperation, NodeDefinition, RunEvent,
  TemplateRecord, ValidationResult, VibeCanvasConfigFile, WorkflowGraph, WorkflowRun
} from '../core/types.js'
import { arePortTypesCompatible } from '../core/port-types.js'
import { defaultConfigForNode, getNodeDefinition } from '../core/node-registry.js'
import { api } from './lib/api.js'
import { ensureImageEditWorkflow } from './lib/edit-workflow.js'
import { Inspector } from './components/Inspector.js'
import { CreatePanel, type GenerateConfig } from './components/CreatePanel.js'
import { WorkflowNode } from './components/WorkflowNode.js'
import { ImageMarkupEditor } from './components/ImageMarkupEditor.js'
import { CandidateSelector } from './components/CandidateSelector.js'
import { ArtifactLineagePanel } from './components/ArtifactLineagePanel.js'
import { RunPanel } from './components/RunPanel.js'
import { ProviderSettings } from './components/ProviderSettings.js'

/** Canvas-visible nodes: freeform items (image/note/annotation). Workflow nodes stay in the graph but are not rendered. */
function isCanvasNode(node: CanvasNode): boolean {
  return node.data.freeform === true || node.data.nodeType.startsWith('canvas.')
}

/** Active run context: tells WebSocket completion handler how to fill results back. */
type ActiveRunContext =
  | { kind: 'generate'; placeholderNodeId: string }
  | { kind: 'edit'; sourceNodeId: string; sourceArtifactId: string; annotationArtifactId: string }

const nodeTypes = { workflow: WorkflowNode }
export default function App() { return <ReactFlowProvider><Studio /></ReactFlowProvider> }

function Studio() {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null)
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [edges, setEdges] = useState<CanvasEdge[]>([])
  const [registry, setRegistry] = useState<NodeDefinition[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [configFile, setConfigFile] = useState<VibeCanvasConfigFile>()
  const [revisions, setRevisions] = useState<Array<{ revision: number; transactionId?: string; createdAt: string }>>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [validation, setValidation] = useState<ValidationResult>()
  const [message, setMessage] = useState('正在加载工作区…')
  const [imageConfigured, setImageConfigured] = useState(false)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [showRuns, setShowRuns] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [candidateRun, setCandidateRun] = useState<WorkflowRun>()
  const [lineage, setLineage] = useState<ArtifactLineage>()
  const [markupMode, setMarkupMode] = useState<'annotation' | 'mask'>()
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateProgress, setGenerateProgress] = useState('')
  const [candidates, setCandidates] = useState<ArtifactRef[]>([])
  const [activeRunId, setActiveRunId] = useState<string>()
  const [activeRunContext, setActiveRunContext] = useState<ActiveRunContext>()
  const flowRef = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const graphRef = useRef<WorkflowGraph | null>(null)
  const nodesRef = useRef<CanvasNode[]>([])
  const activeRunIdRef = useRef<string | undefined>(undefined)
  const activeRunContextRef = useRef<ActiveRunContext | undefined>(undefined)
  const geometryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { graphRef.current = graph }, [graph])
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { activeRunIdRef.current = activeRunId }, [activeRunId])
  useEffect(() => { activeRunContextRef.current = activeRunContext }, [activeRunContext])

  const registryMap = useMemo(() => new Map(registry.map((item) => [item.type, item])), [registry])
  const selectedNode = nodes.find((node) => node.id === selectedNodeId)
  // Only canvas items appear on the board; workflow nodes are hidden but kept in the graph.
  const visibleNodes = useMemo(() => nodes.filter(isCanvasNode), [nodes])
  const visibleEdges = useMemo(() => edges.filter((edge) => {
    const sourceVisible = visibleNodes.some((n) => n.id === edge.source)
    const targetVisible = visibleNodes.some((n) => n.id === edge.target)
    return sourceVisible && targetVisible
  }), [edges, visibleNodes])
  // Cache hidden workflow node IDs so the generate flow can drive them without user seeing them.
  const workflowNodeIds = useMemo(() => {
    const map: Record<string, string> = {}
    for (const node of graph?.nodes || []) {
      if (!isCanvasNode(node)) map[node.data.nodeType] = node.id
    }
    return map
  }, [graph])
  const selectedDefinition = selectedNode ? registryMap.get(selectedNode.data.nodeType) || getNodeDefinition(selectedNode.data.nodeType) : undefined
  const selectedArtifact = selectedNode?.data.config.artifactId ? artifacts.find((item) => item.id === selectedNode.data.config.artifactId) : undefined

  const hydrate = useCallback(async () => {
    const [loadedGraph, loadedRegistry, loadedArtifacts, loadedRuns, loadedTemplates, health] = await Promise.all([
      api.getGraph(), api.getRegistry(), api.getArtifacts(500, undefined, undefined, 'image'), api.getRuns(), api.getTemplates(), api.health()
    ])
    setGraph(loadedGraph); setNodes(loadedGraph.nodes); setEdges(loadedGraph.edges); setRegistry(loadedRegistry)
    setArtifacts(loadedArtifacts); setRuns(loadedRuns); setTemplates(loadedTemplates); setImageConfigured(health.imageConfigured)
    setMessage(`工作区：${health.projectDir} · graph r${loadedGraph.revision}`)
  }, [])

  const refreshRuntime = useCallback(async () => {
    const [loadedArtifacts, loadedRuns] = await Promise.all([api.getArtifacts(500, undefined, undefined, 'image'), api.getRuns()])
    setArtifacts(loadedArtifacts); setRuns(loadedRuns)
  }, [])

  useEffect(() => {
    void hydrate().catch((error) => setMessage(error.message))
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      socket.onmessage = (event) => {
        try {
          const runEvent = JSON.parse(event.data) as RunEvent
          setEvents((current) => [runEvent, ...current].slice(0, 50)); setMessage(runEvent.message || runEvent.type)
          void refreshRuntime()
          if (runEvent.type === 'run-completed' && activeRunIdRef.current === runEvent.runId && activeRunContextRef.current) {
            const context = activeRunContextRef.current
            void api.getArtifacts(100, 'candidate', runEvent.runId).then(async (arts) => {
              const finishGenerate = async (placeholderId: string) => {
                if (arts.length === 1) {
                  await commitPatch([{ op: 'updateNode', nodeId: placeholderId, patch: { config: { artifactId: arts[0].id } } }], '填入生成结果')
                  clearActiveRun()
                  setMessage('生成完成，已填入画布。')
                } else if (arts.length > 1) {
                  setCandidates(arts); setGenerateProgress(''); setIsGenerating(false)
                  setMessage(`生成完成，${arts.length} 张候选，请在左侧选择。`)
                } else {
                  clearActiveRun()
                  setMessage('生成完成但未产出图片。')
                }
              }
              const finishEdit = async (sourceNodeId: string) => {
                if (arts.length === 1) {
                  await placeSiblingImage(sourceNodeId, arts[0].id)
                  clearActiveRun()
                  setMessage('按标注修改完成，新图已放在原图右侧。')
                } else if (arts.length > 1) {
                  setCandidates(arts); setGenerateProgress(''); setIsGenerating(false)
                  setMessage(`按标注修改完成，${arts.length} 张候选，请在左侧选择。`)
                } else {
                  clearActiveRun()
                  setMessage('按标注修改完成但未产出图片。')
                }
              }
              if (context.kind === 'generate') await finishGenerate(context.placeholderNodeId)
              else await finishEdit(context.sourceNodeId)
            })
          }
          if (runEvent.type === 'run-failed' && activeRunIdRef.current === runEvent.runId) {
            clearActiveRun()
            setMessage(`生成失败：${runEvent.message}`)
          }
          if (runEvent.type === 'node-completed' && activeRunIdRef.current === runEvent.runId) {
            const nodeType = (runEvent.payload as { nodeType?: string })?.nodeType
            if (nodeType) setGenerateProgress(`${nodeType} 完成…`)
          }
          if (['run-completed','graph-updated','artifact-updated'].includes(runEvent.type)) void api.getGraph().then(syncGraph)
        } catch { /* ignore */ }
      }
      socket.onclose = () => { if (!closed) timer = setTimeout(connect, 1200) }
    }
    connect()
    return () => { closed = true; if (timer) clearTimeout(timer); socket?.close() }
  }, [hydrate, refreshRuntime])

  const syncGraph = useCallback((next: WorkflowGraph) => {
    setGraph(next); setNodes(next.nodes); setEdges(next.edges)
  }, [])

  const commitPatch = useCallback(async (operations: GraphPatchOperation[], label = '画布更新') => {
    const current = graphRef.current
    if (!current || !operations.length) return current
    try {
      const next = await api.patchGraph({ transactionId: `${label}-${crypto.randomUUID().slice(0, 8)}`, baseRevision: current.revision, operations })
      syncGraph(next); setMessage(`${label}完成 · r${next.revision}`); return next
    } catch (error) {
      const err = error as Error & { code?: string }
      if (err.code === 'REVISION_CONFLICT') { setMessage('检测到 Agent 或其他进程已修改画布，正在合并最新版本。'); await hydrate() }
      throw error
    }
  }, [hydrate, syncGraph])

  const flushGeometry = useCallback(async () => {
    const current = graphRef.current
    if (!current) return
    const operations: GraphPatchOperation[] = []
    for (const node of nodesRef.current) {
      const saved = current.nodes.find((item) => item.id === node.id)
      if (!saved) continue
      if (saved.position.x !== node.position.x || saved.position.y !== node.position.y) operations.push({ op: 'moveNode', nodeId: node.id, position: node.position })
      if (node.width && node.height && (saved.width !== node.width || saved.height !== node.height)) operations.push({ op: 'resizeNode', nodeId: node.id, width: node.width, height: node.height })
    }
    if (operations.length) await commitPatch(operations, '节点布局')
  }, [commitPatch])

  const scheduleGeometry = useCallback(() => {
    if (geometryTimer.current) clearTimeout(geometryTimer.current)
    geometryTimer.current = setTimeout(() => void flushGeometry().catch((error) => setMessage(error.message)), 500)
  }, [flushGeometry])

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => { setNodes((current) => applyNodeChanges(changes, current) as CanvasNode[]); if (changes.some((item) => item.type === 'position' || item.type === 'dimensions')) scheduleGeometry() }, [scheduleGeometry])
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current) as CanvasEdge[])
    const removed = changes.filter((item) => item.type === 'remove').map((item) => ({ op: 'disconnect' as const, edgeId: item.id }))
    if (removed.length) void commitPatch(removed, '删除连接').catch((error) => setMessage(error.message))
  }, [commitPatch])

  const isValidConnection = useCallback((connection: Connection | CanvasEdge) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle || connection.source === connection.target) return false
    const source = nodes.find((node) => node.id === connection.source); const target = nodes.find((node) => node.id === connection.target)
    const sourceDef = source ? registryMap.get(source.data.nodeType) : undefined; const targetDef = target ? registryMap.get(target.data.nodeType) : undefined
    const sourcePort = sourceDef?.outputs.find((port) => port.id === connection.sourceHandle); const targetPort = targetDef?.inputs.find((port) => port.id === connection.targetHandle)
    if (!sourcePort || !targetPort || !arePortTypesCompatible(sourcePort.type, targetPort.type)) return false
    if (!targetPort.multiple && edges.some((edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle)) return false
    return !wouldCreateCycle(edges, connection.source, connection.target)
  }, [nodes, edges, registryMap])

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) return setMessage('连接无效：端口类型、单输入限制或循环依赖不符合要求。')
    const edge = { ...connection, id: `edge-${crypto.randomUUID().slice(0, 8)}` } as CanvasEdge
    setEdges((current) => addEdge(edge, current) as CanvasEdge[])
    void commitPatch([{ op: 'connect', edge }], '添加连接').catch((error) => setMessage(error.message))
  }, [commitPatch, isValidConnection])

  const addNode = useCallback((nodeType: string) => {
    const definition = registryMap.get(nodeType) || getNodeDefinition(nodeType)
    const position = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) || { x: 200, y: 200 }
    const node: CanvasNode = { id: `node-${crypto.randomUUID().slice(0, 8)}`, type: 'workflow', position, width: definition?.defaultSize?.width, height: definition?.defaultSize?.height, data: { nodeType, config: defaultConfigForNode(nodeType), status: 'idle', freeform: definition?.category === 'canvas' } }
    setNodes((current) => [...current, node]); setSelectedNodeId(node.id)
    void commitPatch([{ op: 'addNode', node }], '添加节点').catch((error) => setMessage(error.message))
  }, [commitPatch, registryMap])

  const updateSelectedConfig = useCallback((patch: Record<string, unknown>) => {
    if (!selectedNodeId) return
    setNodes((current) => current.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch }, status: 'idle', statusMessage: undefined } } : node))
    void commitPatch([{ op: 'updateNode', nodeId: selectedNodeId, patch: { config: patch, status: 'idle', statusMessage: undefined } }], '更新节点').catch((error) => setMessage(error.message))
  }, [commitPatch, selectedNodeId])

  const onSelectionChange = useCallback((params: OnSelectionChangeParams<CanvasNode, CanvasEdge>) => {
    setSelectedNodeId(params.nodes[0]?.id)
    void api.saveSelection({ selectedNodeIds: params.nodes.map((node) => node.id), selectedEdgeIds: params.edges.map((edge) => edge.id) })
  }, [])

  const run = useCallback(async (targetNodeId?: string) => {
    await flushGeometry()
    const accepted = await api.run(targetNodeId); setMessage(`已加入异步队列：${accepted.runId}`); setShowRuns(true); await refreshRuntime()
  }, [flushGeometry, refreshRuntime])

  const validate = useCallback(async () => {
    const current = graphRef.current; if (!current) return
    const result = await api.validateGraph({ ...current, nodes: nodesRef.current, edges }); setValidation(result)
    setMessage(result.valid ? `验证通过，拓扑顺序包含 ${result.executionOrder.length} 个节点。` : `发现 ${result.problems.length} 个问题。`)
  }, [edges])

  const uploadForSelected = useCallback(async (file: File, role = 'reference') => {
    const artifact = await api.upload(file, role, 'image'); setArtifacts((current) => [...current, artifact]); updateSelectedConfig({ artifactId: artifact.id }); setMessage(`已上传：${artifact.fileName}`)
  }, [updateSelectedConfig])

  const openLineage = useCallback(async (artifact: ArtifactRef) => setLineage(await api.getLineage(artifact.id)), [])
  const placeArtifact = useCallback(async (artifact: ArtifactRef) => { const result = await api.placeArtifact(artifact.id); syncGraph(result.graph) }, [syncGraph])

  const addPlaceholder = useCallback(() => {
    const position = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) || { x: 300, y: 200 }
    const node: CanvasNode = {
      id: `node-${crypto.randomUUID().slice(0, 8)}`, type: 'workflow', position, width: 380, height: 380,
      data: { nodeType: 'canvas.image', config: { artifactId: '' }, status: 'idle', freeform: true }
    }
    setNodes((current) => [...current, node]); setSelectedNodeId(node.id)
    void commitPatch([{ op: 'addNode', node }], '添加 AI 图片框').catch((error) => setMessage(error.message))
  }, [commitPatch])

  /** 清理当前活跃 run 的所有 UI 和 ref 状态。 */
  const clearActiveRun = useCallback(() => {
    activeRunIdRef.current = undefined
    activeRunContextRef.current = undefined
    setIsGenerating(false); setActiveRunId(undefined); setActiveRunContext(undefined); setGenerateProgress('')
  }, [])

  /** 在源图右侧创建一个新的 canvas.image 兄弟节点,引用 edit 产出的 Artifact。 */
  const placeSiblingImage = useCallback(async (sourceNodeId: string, artifactId: string) => {
    const currentGraph = graphRef.current
    if (!currentGraph) return
    const sourceNode = currentGraph.nodes.find((node) => node.id === sourceNodeId)
    if (!sourceNode) return
    // 在源图右侧放置;若与可见节点相交,则向下递进寻找空位
    const canvasNodes = currentGraph.nodes.filter(isCanvasNode)
    const width = sourceNode.width || 380
    const height = sourceNode.height || 380
    const gap = 60
    let x = sourceNode.position.x + width + gap
    let y = sourceNode.position.y
    const overlaps = () => canvasNodes.some((node) =>
      node.id !== sourceNodeId &&
      x < node.position.x + (node.width || 380) &&
      x + width > node.position.x &&
      y < node.position.y + (node.height || 380) &&
      y + height > node.position.y
    )
    let attempts = 0
    while (overlaps() && attempts < 20) {
    y += height + gap
    attempts += 1
    }
    const newNode: CanvasNode = {
      id: `node-${crypto.randomUUID().slice(0, 8)}`, type: 'workflow', position: { x, y }, width, height,
      data: {
        nodeType: 'canvas.image',
        config: { artifactId },
        status: 'completed',
        freeform: true,
        label: '按标注修改'
      }
    }
    await commitPatch([{ op: 'addNode', node: newNode }], '放置编辑结果')
  }, [commitPatch])

  const generateForPlaceholder = useCallback(async (nodeId: string, prompt: string, config: GenerateConfig) => {
    const briefId = workflowNodeIds['input.brief']
    const generateId = workflowNodeIds['image.generate']
    const aspectId = workflowNodeIds['utility.aspect-ratio']
    if (!briefId || !generateId) { setMessage('画布缺少隐藏的 brief/generate 工作流节点，请先重置为示例工作流。'); return }
    activeRunContextRef.current = { kind: 'generate', placeholderNodeId: nodeId }
    setIsGenerating(true); setCandidates([]); setActiveRunContext({ kind: 'generate', placeholderNodeId: nodeId }); setGenerateProgress('准备生成…')
    try {
      await commitPatch([{ op: 'updateNode', nodeId: briefId, patch: { config: { text: prompt } } }], '更新 brief')
      await commitPatch([{ op: 'updateNode', nodeId: generateId, patch: { config: { quality: config.quality, candidateCount: config.candidateCount, outputFormat: 'png' } } }], '更新 generate 参数')
      if (aspectId) await commitPatch([{ op: 'updateNode', nodeId: aspectId, patch: { config: { width: config.width, height: config.height } } }], '更新尺寸')
      const accepted = await api.run(generateId)
      activeRunIdRef.current = accepted.runId
      setActiveRunId(accepted.runId); setGenerateProgress('正在生成…')
    } catch (error) {
      clearActiveRun()
      setMessage(`生成启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [clearActiveRun, commitPatch, workflowNodeIds])

  /** 把保存好的 annotation Artifact 接入隐藏 image.edit 子图并启动 run。 */
  const editForImage = useCallback(async (sourceNodeId: string, annotationArtifactId: string, notes: string) => {
    const currentGraph = graphRef.current
    if (!currentGraph) { setMessage('画布尚未加载完成。'); return }
    const sourceNode = currentGraph.nodes.find((node) => node.id === sourceNodeId)
    const sourceArtifactId = String(sourceNode?.data.config.artifactId || '')
    if (!sourceArtifactId) { setMessage('源图片未绑定 Artifact，无法编辑。'); return }

    const brief = notes || '根据批注箭头和标签修改原图对应区域。'
    const prepared = ensureImageEditWorkflow(currentGraph, {
      sourceArtifactId,
      annotationArtifactId,
      brief,
      quality: 'high',
      candidateCount: 1
    })

    activeRunContextRef.current = { kind: 'edit', sourceNodeId, sourceArtifactId, annotationArtifactId }
    setIsGenerating(true); setCandidates([])
    setActiveRunContext({ kind: 'edit', sourceNodeId, sourceArtifactId, annotationArtifactId })
    setGenerateProgress(prepared.created ? '准备编辑工作流…' : '更新编辑输入…')

    try {
      await commitPatch(prepared.operations, prepared.created ? '创建编辑工作流' : '更新编辑输入')
      const accepted = await api.run(prepared.nodeIds.edit)
      activeRunIdRef.current = accepted.runId
      setActiveRunId(accepted.runId); setGenerateProgress('正在按标注修改…')
    } catch (error) {
      clearActiveRun()
      setMessage(`编辑启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [clearActiveRun, commitPatch])

  const saveMarkup = useCallback(async (blob: Blob, notes: string) => {
    if (!selectedArtifact || !markupMode || !selectedNode) return
    if (markupMode === 'mask') {
      // mask 模式:创建独立 mask 节点,保持原有行为
      const artifact = await api.upload(blob, 'mask', 'mask', selectedArtifact.id, `mask-${Date.now()}.png`, notes)
      const nodeType = 'input.mask'
      const position = { x: selectedNode.position.x + (selectedNode.width || 380) + 60, y: selectedNode.position.y + 220 }
      const newNode: CanvasNode = { id: `node-${crypto.randomUUID().slice(0, 8)}`, type: 'workflow', position, width: 300, height: 300, data: { nodeType, config: { ...defaultConfigForNode(nodeType), artifactId: artifact.id, sourceArtifactId: selectedArtifact.id, text: notes }, status: 'completed', previewArtifactId: artifact.id, freeform: false } }
      await commitPatch([{ op: 'addNode', node: newNode }], '创建蒙版')
      return
    }
    // annotation 模式:上传 annotation Artifact(带 lineage parents),然后直接触发隐藏 edit 子图
    // annotation 是中间产物,不追加到前端素材列表
    const artifact = await api.upload(blob, 'annotation', 'annotation', selectedArtifact.id, `annotation-${Date.now()}.png`, notes, [selectedArtifact.id])
    await editForImage(selectedNode.id, artifact.id, notes)
  }, [commitPatch, editForImage, markupMode, selectedArtifact, selectedNode])

  const selectCandidate = useCallback(async (artifactId: string) => {
    const context = activeRunContextRef.current
    activeRunIdRef.current = undefined
    activeRunContextRef.current = undefined
    setCandidates([]); setIsGenerating(false); setActiveRunId(undefined); setActiveRunContext(undefined)
    if (!context) return
    if (context.kind === 'generate') {
      await commitPatch([{ op: 'updateNode', nodeId: context.placeholderNodeId, patch: { config: { artifactId } } }], '选择候选')
      setMessage('已选择候选图片填入画布。')
    } else {
      await placeSiblingImage(context.sourceNodeId, artifactId)
      setMessage('已选择候选，新图放在原图右侧。')
    }
  }, [commitPatch, placeSiblingImage])

  const cancelGenerate = useCallback(async () => {
    if (activeRunId) await api.cancelRun(activeRunId)
    clearActiveRun()
  }, [activeRunId, clearActiveRun])

  const loadConfig = useCallback(async () => { setConfigFile(await api.getConfig()); setShowSettings(true) }, [])
  const openHistory = useCallback(async () => { setRevisions(await api.getRevisions()); setShowHistory(true) }, [])
  const saveCurrentTemplate = useCallback(async () => {
    await flushGeometry()
    const name = window.prompt('模板名称：', graphRef.current?.name ? `${graphRef.current.name} 模板` : '我的工作流模板')
    if (!name?.trim()) return
    const description = window.prompt('模板说明（可选）：', graphRef.current?.description || '') || ''
    const created = await api.createTemplate({ name: name.trim(), description, category: 'custom' })
    setTemplates((current) => [...current.filter((item) => item.id !== created.id), created])
    setMessage(`已保存模板：${created.name}`)
  }, [flushGeometry])

  if (!graph) return <div className="boot-screen"><Workflow size={32} /><h1>VibeCanvas</h1><p>{message}</p></div>
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Workflow size={20} /></div><div><strong>VibeCanvas</strong></div></div>
      <div className="top-actions">
        <span className={`provider-state ${imageConfigured ? 'ready' : 'missing'}`}>{imageConfigured ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{imageConfigured ? 'Provider 已配置' : '未配置 Token'}</span>
        <button onClick={() => void openHistory()}><History size={15} />历史</button>
        <button onClick={() => void loadConfig()}><Settings2 size={15} />Provider</button>
        <button onClick={() => { if (confirm('重置画布？')) void api.resetGraph().then(syncGraph) }} title="重置画布"><RotateCcw size={15} /></button>
      </div>
    </header>
    <main className={`studio-grid ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <div className="panel-slot left-panel-slot">
        <CreatePanel
          selectedNode={selectedNode}
          artifacts={artifacts}
          isGenerating={isGenerating}
          generateProgress={generateProgress}
          candidates={candidates}
          onAddPlaceholder={addPlaceholder}
          onGenerate={generateForPlaceholder}
          onSelectCandidate={selectCandidate}
          onCancelGenerate={cancelGenerate}
        />
        <button className="collapse-btn collapse-left" onClick={() => setLeftCollapsed(!leftCollapsed)} title={leftCollapsed ? '展开创作面板' : '收起创作面板'}>
          {leftCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>
      <section className="canvas-shell"><ReactFlow<CanvasNode, CanvasEdge>
        nodes={visibleNodes} edges={visibleEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onDrop={(event) => {
          event.preventDefault()
          const artifactId = event.dataTransfer.getData('application/vibecanvas-artifact')
          if (!artifactId || !flowRef.current) return
          const position = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          const node: CanvasNode = {
            id: `node-${crypto.randomUUID().slice(0, 8)}`, type: 'workflow', position, width: 380, height: 380,
            data: { nodeType: 'canvas.image', config: { artifactId }, status: 'completed', freeform: true }
          }
          void commitPatch([{ op: 'addNode', node }], '拖入素材').catch((error) => setMessage(error.message))
        }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('application/vibecanvas-artifact')) event.preventDefault() }}
        onNodesDelete={(deleted) => void commitPatch(deleted.map((node) => ({ op: 'removeNode' as const, nodeId: node.id })), '删除节点')}
        onSelectionChange={onSelectionChange} isValidConnection={isValidConnection} onInit={(instance) => { flowRef.current = instance }}
        onMoveEnd={(_event, viewport: Viewport) => void commitPatch([{ op: 'setViewport', viewport }], '保存视口')}
        defaultViewport={graph.viewport} minZoom={0.1} maxZoom={2.5} fitView deleteKeyCode={['Backspace','Delete']} selectionOnDrag panOnScroll multiSelectionKeyCode="Shift" colorMode="light">
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} /><Controls position="bottom-left" /><MiniMap pannable zoomable position="bottom-right" />
        <Panel position="top-left" className="canvas-hint">{message}</Panel>
      </ReactFlow></section>
      <div className="panel-slot right-panel-slot">
        <button className="collapse-btn collapse-right" onClick={() => setRightCollapsed(!rightCollapsed)} title={rightCollapsed ? '展开属性面板' : '收起属性面板'}>
          {rightCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
        <Inspector node={selectedNode} definition={selectedDefinition} artifacts={artifacts} onChange={updateSelectedConfig} onRun={() => selectedNode && void run(selectedNode.id)} onUpload={uploadForSelected} onOpenEditor={setMarkupMode} onLineage={(artifact) => void openLineage(artifact)} onPlaceArtifact={(artifact) => void placeArtifact(artifact)} />
      </div>
    </main>
    <footer className="statusbar"><span>{artifacts.length} 素材 · {runs.filter((item) => ['queued','running','needs-input'].includes(item.status)).length} 活跃 Run</span><span className="event-line">{events[0]?.message || '画布已就绪。'}</span></footer>

    {markupMode && selectedArtifact ? <ImageMarkupEditor artifact={selectedArtifact} mode={markupMode} onClose={() => setMarkupMode(undefined)} onSave={saveMarkup} /> : null}
    {showRuns ? <RunPanel runs={runs} onClose={() => setShowRuns(false)} onCancel={async (id) => { await api.cancelRun(id); await refreshRuntime() }} onChoose={(item) => { setCandidateRun(item); setShowRuns(false) }} /> : null}
    {candidateRun ? <CandidateSelector run={candidateRun} onClose={() => setCandidateRun(undefined)} onSelect={async (nodeId, artifactId) => { await api.selectCandidate(candidateRun.id, nodeId, artifactId); setCandidateRun(undefined); await refreshRuntime() }} /> : null}
    {lineage ? <ArtifactLineagePanel lineage={lineage} onClose={() => setLineage(undefined)} onStatus={async (artifact, status) => { await api.setArtifactStatus(artifact.id, status); setLineage(await api.getLineage(artifact.id)); await refreshRuntime() }} /> : null}
    {showSettings && configFile ? <ProviderSettings config={configFile} onClose={() => setShowSettings(false)} onSave={async (id, profile) => { await api.saveProvider(id, profile); setShowSettings(false); setMessage('Provider 已保存，请重启 VibeCanvas Web 与 MCP 进程。') }} /> : null}
    {showHistory ? <div className="modal-backdrop"><section className="modal-card history-modal"><header><div><strong>Graph Revision 历史</strong><small>每次事务 Patch 都会保存可恢复快照。</small></div><button onClick={() => setShowHistory(false)}>×</button></header><div className="revision-list">{revisions.map((item) => <article key={item.revision}><div><strong>Revision {item.revision}</strong><small>{item.transactionId || 'unknown'} · {new Date(item.createdAt).toLocaleString()}</small></div><button onClick={() => { if (confirm(`恢复到 revision ${item.revision}？`)) void api.restoreRevision(item.revision).then((next) => { syncGraph(next); setShowHistory(false) }) }}>恢复</button></article>)}</div></section></div> : null}
  </div>
}

function wouldCreateCycle(edges: CanvasEdge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
  adjacency.set(source, [...(adjacency.get(source) ?? []), target])
  const stack = [target]; const visited = new Set<string>()
  while (stack.length) { const current = stack.pop()!; if (current === source) return true; if (visited.has(current)) continue; visited.add(current); stack.push(...(adjacency.get(current) ?? [])) }
  return false
}
