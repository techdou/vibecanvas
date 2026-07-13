import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { nanoid } from 'nanoid'
import { WebSocketServer } from 'ws'
import type { Request, Response, NextFunction } from 'express'
import { ConfigStore, getRuntimeConfig, redactConfig, type RuntimeConfig } from '../core/config.js'
import { RevisionConflictError, validateGraph } from '../core/graph.js'
import { NODE_REGISTRY, defaultConfigForNode, getNodeDefinition } from '../core/node-registry.js'
import { OpenCodeBridge } from '../core/opencode-bridge.js'
import { WorkflowRunner } from '../core/runner.js'
import { RunQueue } from '../core/run-queue.js'
import { WorkspaceStorage } from '../core/storage.js'
import type { ArtifactRef, CanvasNode, GraphPatch, ImageProviderProfile, RunEvent, WorkflowGraph } from '../core/types.js'
import { nowIso } from '../core/utils.js'

export interface AppRuntime {
  app: express.Express
  server: ReturnType<typeof createServer>
  storage: WorkspaceStorage
  runner: WorkflowRunner
  queue: RunQueue
  config: RuntimeConfig
}

export async function createVibeCanvasApp(providedConfig?: RuntimeConfig): Promise<AppRuntime> {
  const config = providedConfig ?? await getRuntimeConfig()
  const storage = new WorkspaceStorage(config.projectDir)
  await storage.init()
  const runner = new WorkflowRunner(storage, config)
  const queue = new RunQueue(storage, runner, config)
  const openCode = new OpenCodeBridge(config.openCode)
  const configStore = new ConfigStore(config.configFile)
  const app = express()
  const server = createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024, files: 10 } })

  app.use(cors())
  app.use(express.json({ limit: '35mb' }))
  app.use(express.urlencoded({ extended: true }))

  queue.on('event', (event: RunEvent) => {
    const message = JSON.stringify(event)
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(message)
  })
  queue.start()

  app.get('/api/health', async (_req, res) => {
    res.json({
      ok: true, version: '2.0.0', projectDir: storage.projectDir, databaseFile: storage.databaseFile,
      configFile: config.configFile, imageConfigured: Boolean(config.image.apiKey), providerId: config.image.id,
      sqliteWal: true, queueWorkerId: queue.workerId
    })
  })

  app.get('/api/workspace', async (_req, res) => res.json(await storage.context()))
  app.get('/api/graph', async (_req, res) => res.json(await storage.loadGraph()))
  app.put('/api/graph', async (req, res) => {
    const graph = req.body as WorkflowGraph
    const validation = validateGraph(graph)
    if (!validation.valid) return res.status(400).json(validation)
    res.json(await storage.saveGraph(graph, Number(req.body.revision), `web-full-${nanoid(8)}`))
  })
  app.post('/api/graph/patch', async (req, res) => res.json(await storage.applyPatch(req.body as GraphPatch)))
  app.get('/api/graph/revisions', async (_req, res) => res.json(await storage.listGraphRevisions()))
  app.post('/api/graph/revisions/:revision/restore', async (req, res) => res.json(await storage.restoreGraphRevision(Number(req.params.revision))))
  app.post('/api/graph/reset', async (_req, res) => {
    const { createStarterGraph } = await import('../core/templates.js')
    const current = await storage.loadGraph()
    const starter = createStarterGraph(); starter.id = current.id; starter.revision = current.revision; starter.createdAt = current.createdAt
    res.json(await storage.saveGraph(starter, current.revision, `reset-${nanoid(8)}`))
  })
  app.post('/api/graph/validate', async (req, res) => {
    const graph = (req.body && req.body.nodes ? req.body : await storage.loadGraph()) as WorkflowGraph
    res.json(validateGraph(graph))
  })

  app.get('/api/node-registry', (_req, res) => res.json(NODE_REGISTRY))
  app.post('/api/nodes', async (req, res) => {
    const nodeType = String(req.body.nodeType || '')
    const definition = getNodeDefinition(nodeType)
    if (!definition) return res.status(400).json({ error: `Unknown node type: ${nodeType}` })
    const graph = await storage.loadGraph()
    const node: CanvasNode = {
      id: `node-${nanoid(8)}`, type: 'workflow', position: req.body.position || { x: 100, y: 100 },
      width: definition.defaultSize?.width, height: definition.defaultSize?.height,
      data: { nodeType, config: { ...defaultConfigForNode(nodeType), ...(req.body.config || {}) }, status: 'idle', freeform: definition.category === 'canvas' }
    }
    const next = await storage.applyPatch({ transactionId: `add-node-${nanoid(8)}`, baseRevision: graph.revision, operations: [{ op: 'addNode', node }] })
    res.status(201).json({ node, graph: next })
  })

  app.get('/api/selection', async (_req, res) => res.json(await storage.loadSelection()))
  app.put('/api/selection', async (req, res) => res.json(await storage.saveSelection({
    selectedNodeIds: Array.isArray(req.body.selectedNodeIds) ? req.body.selectedNodeIds : [],
    selectedEdgeIds: Array.isArray(req.body.selectedEdgeIds) ? req.body.selectedEdgeIds : []
  })))

  app.post('/api/uploads', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    const filePath = await storage.saveUploadedFile(req.file.buffer, req.file.originalname)
    const role = String(req.body.role || 'reference')
    const kind = normalizeArtifactKind(req.body.kind)
    const parents = String(req.body.parentArtifactIds || '').split(',').map((item) => item.trim()).filter(Boolean)
    const artifact = await storage.registerArtifact({ filePath, kind, status: kind === 'image' ? 'draft' : 'candidate', parentArtifactIds: parents, metadata: { role, source: 'upload', sourceArtifactId: req.body.sourceArtifactId || undefined, notes: req.body.notes || undefined } })
    res.status(201).json(artifact)
  })

  app.get('/api/artifacts', async (req, res) => res.json(await storage.listArtifacts({
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    status: typeof req.query.status === 'string' ? req.query.status as ArtifactRef['status'] : undefined,
    runId: typeof req.query.runId === 'string' ? req.query.runId : undefined
  })))
  app.get('/api/artifacts/:id', async (req, res) => {
    const artifact = await storage.getArtifact(req.params.id)
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' })
    res.json(artifact)
  })
  app.get('/api/artifacts/:id/lineage', async (req, res) => res.json(await storage.artifactLineage(req.params.id)))
  app.patch('/api/artifacts/:id/status', async (req, res) => res.json(await storage.updateArtifactStatus(req.params.id, req.body.status, req.body.metadata || {})))
  app.get('/api/artifacts/:id/file', async (req, res) => {
    const artifact = await storage.getArtifact(req.params.id)
    if (!artifact) return res.status(404).end()
    res.type(artifact.mimeType); res.sendFile(artifact.filePath)
  })

  app.post('/api/runs', async (req, res) => {
    const targetNodeId = typeof req.body.targetNodeId === 'string' && req.body.targetNodeId ? req.body.targetNodeId : undefined
    if (targetNodeId) {
      const graph = await storage.loadGraph()
      if (!graph.nodes.some((node) => node.id === targetNodeId)) return res.status(400).json({ error: `Target node not found: ${targetNodeId}`, code: 'INVALID_TARGET' })
    }
    const run = await queue.enqueue(targetNodeId)
    res.status(202).json({ accepted: true, runId: run.id, status: run.status, targetNodeId })
  })
  app.get('/api/runs', async (req, res) => res.json(await storage.listRuns(Number(req.query.limit || 100))))
  app.get('/api/runs/:id', async (req, res) => {
    const run = await storage.loadRun(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    res.json(run)
  })
  app.get('/api/runs/:id/events', async (req, res) => res.json(await storage.listRunEvents(req.params.id, Number(req.query.after || 0))))
  app.post('/api/runs/:id/cancel', async (req, res) => res.json({ cancelled: await queue.cancel(req.params.id) }))
  app.post('/api/runs/:id/nodes/:nodeId/select', async (req, res) => {
    const artifactId = String(req.body.artifactId || '')
    if (!artifactId) return res.status(400).json({ error: 'artifactId is required' })
    const run = await storage.resolveRunSelection(req.params.id, req.params.nodeId, artifactId)
    res.json({ accepted: true, runId: run.id, status: run.status })
  })

  app.get('/api/templates', async (_req, res) => res.json(await storage.listTemplates()))
  app.post('/api/templates', async (req, res) => {
    const graph = req.body.graph || await storage.loadGraph()
    res.status(201).json(await storage.saveTemplate({ id: req.body.id || `template-${nanoid(10)}`, name: String(req.body.name || '未命名模板'), description: String(req.body.description || ''), category: String(req.body.category || 'custom'), graph, builtIn: false }))
  })
  app.post('/api/templates/:id/apply', async (req, res) => res.json(await storage.applyTemplate(req.params.id)))

  app.get('/api/config', async (_req, res) => res.json(redactConfig(await configStore.load())))
  app.put('/api/config/providers/:id', async (req, res) => {
    const file = await configStore.load()
    const existing = file.providers[req.params.id] || config.image
    const body = req.body as Partial<ImageProviderProfile>
    const profile: ImageProviderProfile = {
      ...existing, ...body, id: req.params.id,
      apiKey: !body.apiKey || body.apiKey === '********' ? existing.apiKey : body.apiKey,
      headers: mergeSecrets(existing.headers, body.headers), downloadHeaders: mergeSecrets(existing.downloadHeaders, body.downloadHeaders),
      capabilities: { ...existing.capabilities, ...(body.capabilities || {}) }, costs: { ...existing.costs, ...(body.costs || {}) }, extraJson: { ...existing.extraJson, ...(body.extraJson || {}) }
    }
    const saved = await configStore.updateProvider(profile, req.body.makeActive !== false)
    res.json({ config: redactConfig(saved), restartRequired: true })
  })
  app.get('/api/provider/capabilities', (_req, res) => res.json({ providerId: config.image.id, model: config.image.model, capabilities: runner.capabilities(), configured: Boolean(config.image.apiKey), costs: config.image.costs }))

  app.get('/api/host/opencode/health', async (_req, res) => res.json(await openCode.health()))
  app.get('/api/host/opencode/sessions', async (_req, res) => res.json(await openCode.listSessions()))
  app.post('/api/host/opencode/sessions', async (req, res) => res.status(201).json(await openCode.createSession(String(req.body.title || 'VibeCanvas Creative Session'))))
  app.post('/api/host/opencode/send', async (req, res) => {
    const graph = await storage.loadGraph(); const selection = await storage.loadSelection()
    const selectedNodes = graph.nodes.filter((node) => selection.selectedNodeIds.includes(node.id))
    const prompt = String(req.body.prompt || buildSelectionPrompt(graph, selectedNodes))
    const response = await openCode.sendMessage({ sessionId: req.body.sessionId, prompt, agent: req.body.agent, asynchronous: req.body.asynchronous !== false })
    res.json({ ok: true, response })
  })

  app.post('/api/artifacts/:id/place', async (req, res) => {
    const artifact = await storage.getArtifact(req.params.id)
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' })
    const graph = await storage.loadGraph()
    const node: CanvasNode = {
      id: `node-${nanoid(8)}`, type: 'workflow', position: req.body.position || findClearPosition(graph), width: 380, height: 380,
      data: { nodeType: 'canvas.image', config: { artifactId: artifact.id }, status: 'completed', previewArtifactId: artifact.id, outputs: { image: artifact }, freeform: true }
    }
    const next = await storage.applyPatch({ transactionId: `place-${nanoid(8)}`, baseRevision: graph.revision, operations: [{ op: 'addNode', node }] })
    res.status(201).json({ node, graph: next })
  })

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const staticDir = process.env.VIBECANVAS_WEB_DIR || path.resolve(__dirname, '../web')
  app.use(express.static(staticDir))
  app.get('*path', (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next(); res.sendFile(path.join(staticDir, 'index.html')) })

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof RevisionConflictError) return res.status(409).json({ error: error.message, code: error.code, currentRevision: error.currentRevision, suppliedRevision: error.suppliedRevision })
    console.error(error)
    res.status(500).json({ error: error instanceof Error ? error.message : String(error), timestamp: nowIso() })
  })

  server.on('close', () => { queue.stop(); storage.close() })
  return { app, server, storage, runner, queue, config }
}

function buildSelectionPrompt(graph: WorkflowGraph, selectedNodes: CanvasNode[]): string {
  const selection = selectedNodes.length ? selectedNodes : graph.nodes
  return [
    '使用 VibeCanvas Skills 和 MCP 工具处理当前画布。', `画布：${graph.name}，revision=${graph.revision}，模式：${graph.mode}。`,
    `目标节点：${selection.map((node) => `${node.id} (${node.data.nodeType})`).join(', ') || '无明确选择'}。`,
    '先读取 selection 和 graph；所有修改必须使用带 baseRevision 的 apply_graph_patch；高成本运行使用 start_run 并通过 get_run_status 轮询，不要同步等待。'
  ].join('\n')
}
function findClearPosition(graph: WorkflowGraph): { x: number; y: number } { return { x: graph.nodes.reduce((max, node) => Math.max(max, node.position.x + (node.width || 320)), 0) + 80, y: 80 } }
function normalizeArtifactKind(value: unknown): ArtifactRef['kind'] { return ['image', 'mask', 'annotation', 'json', 'text'].includes(String(value)) ? String(value) as ArtifactRef['kind'] : 'image' }
function mergeSecrets(current: Record<string, string>, incoming?: Record<string, string>): Record<string, string> {
  if (!incoming) return current
  return Object.fromEntries(Object.entries({ ...current, ...incoming }).map(([key, value]) => [key, value === '********' ? current[key] || '' : value]))
}
