import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow,
  ReactFlowProvider, type Connection, type EdgeChange, type NodeChange, type OnSelectionChangeParams, type ReactFlowInstance, type Viewport
} from '@xyflow/react'
import { BookmarkPlus, CheckCircle2, CircleAlert, Clock3, History, Play, RotateCcw, Settings2, Workflow } from 'lucide-react'
import type {
  ArtifactLineage, ArtifactRef, CanvasEdge, CanvasNode, GraphPatchOperation, NodeDefinition, RunEvent,
  TemplateRecord, ValidationResult, VibeCanvasConfigFile, WorkflowGraph, WorkflowRun
} from '../core/types.js'
import { arePortTypesCompatible } from '../core/port-types.js'
import { defaultConfigForNode, getNodeDefinition } from '../core/node-registry.js'
import { api } from './lib/api.js'
import { Inspector } from './components/Inspector.js'
import { NodePalette } from './components/NodePalette.js'
import { WorkflowNode } from './components/WorkflowNode.js'
import { ImageMarkupEditor } from './components/ImageMarkupEditor.js'
import { CandidateSelector } from './components/CandidateSelector.js'
import { ArtifactLineagePanel } from './components/ArtifactLineagePanel.js'
import { RunPanel } from './components/RunPanel.js'
import { ProviderSettings } from './components/ProviderSettings.js'

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
  const flowRef = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const graphRef = useRef<WorkflowGraph | null>(null)
  const nodesRef = useRef<CanvasNode[]>([])
  const geometryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { graphRef.current = graph }, [graph])
  useEffect(() => { nodesRef.current = nodes }, [nodes])

  const registryMap = useMemo(() => new Map(registry.map((item) => [item.type, item])), [registry])
  const selectedNode = nodes.find((node) => node.id === selectedNodeId)
  const selectedDefinition = selectedNode ? registryMap.get(selectedNode.data.nodeType) || getNodeDefinition(selectedNode.data.nodeType) : undefined
  const selectedArtifact = selectedNode?.data.config.artifactId ? artifacts.find((item) => item.id === selectedNode.data.config.artifactId) : undefined

  const hydrate = useCallback(async () => {
    const [loadedGraph, loadedRegistry, loadedArtifacts, loadedRuns, loadedTemplates, health] = await Promise.all([
      api.getGraph(), api.getRegistry(), api.getArtifacts(), api.getRuns(), api.getTemplates(), api.health()
    ])
    setGraph(loadedGraph); setNodes(loadedGraph.nodes); setEdges(loadedGraph.edges); setRegistry(loadedRegistry)
    setArtifacts(loadedArtifacts); setRuns(loadedRuns); setTemplates(loadedTemplates); setImageConfigured(health.imageConfigured)
    setMessage(`工作区：${health.projectDir} · graph r${loadedGraph.revision}`)
  }, [])

  const refreshRuntime = useCallback(async () => {
    const [loadedArtifacts, loadedRuns] = await Promise.all([api.getArtifacts(), api.getRuns()])
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

  const saveMarkup = useCallback(async (blob: Blob, notes: string) => {
    if (!selectedArtifact || !markupMode || !selectedNode) return
    const kind = markupMode === 'mask' ? 'mask' : 'annotation'
    const artifact = await api.upload(blob, markupMode, kind, selectedArtifact.id, `${kind}-${Date.now()}.png`, notes)
    setArtifacts((current) => [...current, artifact])
    const nodeType = markupMode === 'mask' ? 'input.mask' : 'input.annotation'
    const position = { x: selectedNode.position.x + (selectedNode.width || 380) + 60, y: selectedNode.position.y + (markupMode === 'mask' ? 220 : 0) }
    const newNode: CanvasNode = { id: `node-${crypto.randomUUID().slice(0, 8)}`, type: 'workflow', position, width: 300, height: 300, data: { nodeType, config: { ...defaultConfigForNode(nodeType), artifactId: artifact.id, sourceArtifactId: selectedArtifact.id, text: notes }, status: 'completed', previewArtifactId: artifact.id, freeform: false } }
    await commitPatch([{ op: 'addNode', node: newNode }], markupMode === 'mask' ? '创建蒙版' : '创建批注')
  }, [commitPatch, markupMode, selectedArtifact, selectedNode])

  const openLineage = useCallback(async (artifact: ArtifactRef) => setLineage(await api.getLineage(artifact.id)), [])
  const placeArtifact = useCallback(async (artifact: ArtifactRef) => { const result = await api.placeArtifact(artifact.id); syncGraph(result.graph) }, [syncGraph])

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
  const mode = graph.mode
  return <div className={`app-shell mode-${mode}`}>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Workflow size={20} /></div><div><strong>VibeCanvas 2</strong><small>Agent-native Visual Workflow Canvas · r{graph.revision}</small></div></div>
      <div className="mode-switch">{(['free','workflow','hybrid'] as const).map((item) => <button key={item} className={mode === item ? 'active' : ''} onClick={() => void commitPatch([{ op: 'setMode', mode: item }], '切换模式')}>{item === 'free' ? '自由创作' : item === 'workflow' ? '工作流' : '混合模式'}</button>)}</div>
      <div className="template-switch"><select defaultValue="" onChange={(e) => { if (e.target.value && confirm('应用模板会替换当前设计图，是否继续？')) void api.applyTemplate(e.target.value).then(syncGraph); e.target.value = '' }}><option value="">应用模板…</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select><button title="保存当前画布为模板" onClick={() => void saveCurrentTemplate()}><BookmarkPlus size={15} /></button></div>
      <div className="top-actions">
        <span className={`provider-state ${imageConfigured ? 'ready' : 'missing'}`}>{imageConfigured ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{imageConfigured ? 'Provider 已配置' : '未配置 Token'}</span>
        <button onClick={() => void openHistory()}><History size={15} />历史</button><button onClick={() => void loadConfig()}><Settings2 size={15} />Provider</button>
        <button onClick={() => void validate()}><Settings2 size={15} />验证</button><button onClick={() => setShowRuns(true)}><Clock3 size={15} />运行</button>
        <button onClick={() => void run()} className="primary"><Play size={15} />运行全部</button>
        <button onClick={() => { if (confirm('重置为示例工作流？')) void api.resetGraph().then(syncGraph) }} title="重置示例"><RotateCcw size={15} /></button>
      </div>
    </header>
    <main className="studio-grid">
      <NodePalette registry={registry} onAdd={addNode} />
      <section className="canvas-shell"><ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onNodesDelete={(deleted) => void commitPatch(deleted.map((node) => ({ op: 'removeNode' as const, nodeId: node.id })), '删除节点')}
        onSelectionChange={onSelectionChange} isValidConnection={isValidConnection} onInit={(instance) => { flowRef.current = instance }}
        onMoveEnd={(_event, viewport: Viewport) => void commitPatch([{ op: 'setViewport', viewport }], '保存视口')}
        defaultViewport={graph.viewport} minZoom={0.1} maxZoom={2.5} fitView deleteKeyCode={['Backspace','Delete']} selectionOnDrag panOnScroll multiSelectionKeyCode="Shift" colorMode="light">
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} /><Controls position="bottom-left" /><MiniMap pannable zoomable position="bottom-right" />
        <Panel position="top-left" className="canvas-hint">{message}</Panel>
        {validation ? <Panel position="bottom-center" className={`validation-banner ${validation.valid ? 'valid' : 'invalid'}`}>{validation.valid ? '工作流有效' : validation.problems.slice(0, 2).map((problem) => problem.message).join(' · ')}</Panel> : null}
      </ReactFlow></section>
      <Inspector node={selectedNode} definition={selectedDefinition} artifacts={artifacts} onChange={updateSelectedConfig} onRun={() => selectedNode && void run(selectedNode.id)} onUpload={uploadForSelected} onOpenEditor={setMarkupMode} onLineage={(artifact) => void openLineage(artifact)} onPlaceArtifact={(artifact) => void placeArtifact(artifact)} />
    </main>
    <footer className="statusbar"><span>{nodes.length} 节点 · {edges.length} 连接 · {artifacts.length} 素材 · {runs.filter((item) => ['queued','running','needs-input'].includes(item.status)).length} 活跃 Run</span><span className="event-line">{events[0]?.message || '画布已就绪。'}</span></footer>

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
