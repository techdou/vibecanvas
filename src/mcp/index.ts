#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { getRuntimeConfig } from '../core/config.js'
import { validateGraph } from '../core/graph.js'
import { NODE_REGISTRY, defaultConfigForNode, getNodeDefinition } from '../core/node-registry.js'
import { WorkflowRunner } from '../core/runner.js'
import { RunQueue } from '../core/run-queue.js'
import { WorkspaceStorage } from '../core/storage.js'
import type { CanvasNode, GraphPatch } from '../core/types.js'

export interface McsServerHandle {
  stop: () => Promise<void>
}

/**
 * Boot the VibeCanvas MCP server on stdio. Exposes the 21-tool surface backed by
 * the same SQLite/Artifact store the Web process uses. Safe to call from the CLI
 * 'mcp' subcommand or directly when this module is the Node entry point.
 */
export async function startMcpServer(): Promise<McsServerHandle> {
  const config = await getRuntimeConfig()
  const storage = new WorkspaceStorage(config.projectDir)
  await storage.init()
  const runner = new WorkflowRunner(storage, config)
  const queue = new RunQueue(storage, runner, config)
  queue.start()

  const server = new McpServer(
    { name: 'vibecanvas', version: '2.0.0' },
    { instructions: [
      'VibeCanvas is an agent-native visual workflow canvas backed by SQLite/WAL.',
      'Read selection and graph context before editing. Every graph change must use apply_graph_patch with the current baseRevision.',
      'Runs are asynchronous: use start_run or run_to_node, then poll get_run_status or get_run_events. Use cancel_run for cancellation.',
      'Never rewrite the complete graph from a stale snapshot. Generated artifacts have indexed lineage and persistent final/selected status.'
    ].join(' ') }
  )

  server.registerTool('get_workspace_context', { title: 'Get VibeCanvas Workspace Context', description: 'Return project paths, SQLite database, graph revision, and selection.', inputSchema: {} }, async () => result(await storage.context()))

  server.registerTool('get_selection_context', { title: 'Get VibeCanvas Selection Context', description: 'Return selected nodes, edges, definitions, and connected neighbors.', inputSchema: {} }, async () => {
    const [graph, selection] = await Promise.all([storage.loadGraph(), storage.loadSelection()])
    const selectedNodes = graph.nodes.filter((node) => selection.selectedNodeIds.includes(node.id))
    const selectedEdges = graph.edges.filter((edge) => selection.selectedEdgeIds.includes(edge.id))
    const related = new Set(selectedNodes.map((node) => node.id))
    for (const edge of graph.edges) if (related.has(edge.source) || related.has(edge.target)) { related.add(edge.source); related.add(edge.target) }
    return result({ graphRevision: graph.revision, selection, selectedNodes, selectedEdges, relatedNodes: graph.nodes.filter((node) => related.has(node.id)), definitions: selectedNodes.map((node) => getNodeDefinition(node.data.nodeType)) })
  })

  server.registerTool('get_graph', { title: 'Get VibeCanvas Graph', description: 'Read the complete typed graph including its current revision.', inputSchema: {} }, async () => result(await storage.loadGraph()))
  server.registerTool('get_node_registry', { title: 'Get Node Registry', description: 'Return available node types and typed ports.', inputSchema: { category: z.string().optional() } }, async ({ category }) => result(category ? NODE_REGISTRY.filter((node) => node.category === category) : NODE_REGISTRY))

  server.registerTool('apply_graph_patch', {
    title: 'Apply Transactional Graph Patch', description: 'Atomically apply graph operations with optimistic revision control.',
    inputSchema: { transactionId: z.string().min(1), baseRevision: z.number().int().nonnegative(), operations: z.array(z.record(z.string(), z.unknown())).min(1) }
  }, async ({ transactionId, baseRevision, operations }) => result(await storage.applyPatch({ transactionId, baseRevision, operations } as GraphPatch)))

  server.registerTool('add_node', {
    title: 'Add VibeCanvas Node', description: 'Add one registered node using a revision-controlled transaction.',
    inputSchema: { nodeType: z.string(), x: z.number().optional(), y: z.number().optional(), config: z.record(z.string(), z.unknown()).optional(), baseRevision: z.number().int().nonnegative() }
  }, async ({ nodeType, x = 100, y = 100, config: nodeConfig = {}, baseRevision }) => {
    const definition = getNodeDefinition(nodeType)
    if (!definition) throw new Error(`Unknown node type: ${nodeType}`)
    const node: CanvasNode = {
      id: `node-${nanoid(8)}`, type: 'workflow', position: { x, y }, width: definition.defaultSize?.width, height: definition.defaultSize?.height,
      data: { nodeType, config: { ...defaultConfigForNode(nodeType), ...nodeConfig }, status: 'idle', freeform: definition.category === 'canvas' }
    }
    const graph = await storage.applyPatch({ transactionId: `mcp-add-${nanoid(8)}`, baseRevision, operations: [{ op: 'addNode', node }] })
    return result({ node, graphRevision: graph.revision })
  })

  server.registerTool('validate_graph', { title: 'Validate Graph', description: 'Check schema, node types, ports, required inputs, parents, and cycles.', inputSchema: {} }, async () => result(validateGraph(await storage.loadGraph())))

  server.registerTool('start_run', { title: 'Start Asynchronous Run', description: 'Queue a full workflow run and return immediately with runId.', inputSchema: {} }, async () => {
    const run = await queue.enqueue()
    return result({ runId: run.id, status: run.status, graphRevision: run.graphRevision })
  })
  server.registerTool('run_graph', { title: 'Queue Full Graph Run', description: 'Compatibility alias for start_run. Returns immediately.', inputSchema: {} }, async () => {
    const run = await queue.enqueue(); return result({ runId: run.id, status: run.status, graphRevision: run.graphRevision })
  })
  server.registerTool('run_to_node', { title: 'Queue Run to Node', description: 'Queue a target node and its ancestors. Invalid node IDs are rejected before queueing.', inputSchema: { nodeId: z.string().min(1) } }, async ({ nodeId }) => {
    const run = await queue.enqueue(nodeId); return result({ runId: run.id, status: run.status, targetNodeId: nodeId, graphRevision: run.graphRevision })
  })
  server.registerTool('get_run_status', { title: 'Get Run Status', description: 'Read one run or list recent runs.', inputSchema: { runId: z.string().optional() } }, async ({ runId }) => result(runId ? await storage.loadRun(runId) : await storage.listRuns()))
  server.registerTool('get_run_events', { title: 'Get Run Events', description: 'Read incremental persisted events for a run.', inputSchema: { runId: z.string().min(1), afterSeq: z.number().int().nonnegative().optional() } }, async ({ runId, afterSeq = 0 }) => result(await storage.listRunEvents(runId, afterSeq)))
  server.registerTool('cancel_run', { title: 'Cancel Run', description: 'Cancel a queued or running workflow and propagate AbortSignal to active API calls.', inputSchema: { runId: z.string().min(1) } }, async ({ runId }) => result({ cancelled: await queue.cancel(runId) }))
  server.registerTool('resolve_human_selection', { title: 'Resolve Candidate Selection', description: 'Select an artifact for a paused candidate selector and requeue the run.', inputSchema: { runId: z.string().min(1), nodeId: z.string().min(1), artifactId: z.string().min(1) } }, async ({ runId, nodeId, artifactId }) => result(await storage.resolveRunSelection(runId, nodeId, artifactId)))

  server.registerTool('inspect_artifact', { title: 'Inspect Artifact', description: 'Return artifact metadata, persistent status, and lineage.', inputSchema: { artifactId: z.string().min(1) } }, async ({ artifactId }) => result(await storage.artifactLineage(artifactId)))
  server.registerTool('list_artifacts', { title: 'List Artifacts', description: 'List indexed project artifacts.', inputSchema: { limit: z.number().int().min(1).max(1000).optional(), status: z.string().optional() } }, async ({ limit = 100, status }) => result(await storage.listArtifacts({ limit, status: status as never })))
  server.registerTool('set_artifact_status', { title: 'Set Artifact Status', description: 'Persist draft, candidate, selected, final, or archived state.', inputSchema: { artifactId: z.string().min(1), status: z.enum(['draft', 'candidate', 'selected', 'final', 'archived']) } }, async ({ artifactId, status }) => result(await storage.updateArtifactStatus(artifactId, status)))

  server.registerTool('place_artifact', {
    title: 'Place Artifact on Canvas', description: 'Create a freeform image node with a transactional graph patch.',
    inputSchema: { artifactId: z.string().min(1), x: z.number().optional(), y: z.number().optional(), baseRevision: z.number().int().nonnegative() }
  }, async ({ artifactId, x, y, baseRevision }) => {
    const artifact = await storage.getArtifact(artifactId)
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`)
    const graph = await storage.loadGraph()
    if (graph.revision !== baseRevision) throw new Error(`Graph revision conflict: current=${graph.revision}, supplied=${baseRevision}`)
    const maxX = graph.nodes.reduce((max, node) => Math.max(max, node.position.x + (node.width || 320)), 0)
    const node: CanvasNode = {
      id: `node-${nanoid(8)}`, type: 'workflow', position: { x: x ?? maxX + 80, y: y ?? 80 }, width: 380, height: 380,
      data: { nodeType: 'canvas.image', config: { artifactId }, status: 'completed', outputs: { image: artifact }, previewArtifactId: artifactId, freeform: true }
    }
    const updated = await storage.applyPatch({ transactionId: `mcp-place-${nanoid(8)}`, baseRevision, operations: [{ op: 'addNode', node }] })
    return result({ node, graphRevision: updated.revision })
  })

  server.registerTool('list_templates', { title: 'List Workflow Templates', description: 'List built-in and user workflow templates.', inputSchema: {} }, async () => result(await storage.listTemplates()))
  server.registerTool('apply_template', { title: 'Apply Workflow Template', description: 'Replace the current design graph using a revisioned template transaction.', inputSchema: { templateId: z.string().min(1) } }, async ({ templateId }) => result(await storage.applyTemplate(templateId)))
  server.registerTool('get_provider_capabilities', { title: 'Get Provider Capabilities', description: 'Return configured Image 2 provider capabilities and cost table.', inputSchema: {} }, async () => result({ providerId: config.image.id, model: config.image.model, capabilities: runner.capabilities(), costs: config.image.costs, configured: Boolean(config.image.apiKey) }))

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const stop = async () => { queue.stop(); storage.close() }
  process.on('SIGINT', () => { void stop().finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { void stop().finally(() => process.exit(0)) })
  return { stop }
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], structuredContent: value && typeof value === 'object' ? value as Record<string, unknown> : { value } }
}

// Auto-start only when this file is the Node entry point (directly invoked as
// `node mcp.js` or spawned that way by an MCP client). When imported by the CLI
// (`vibecanvas mcp`), the CLI calls startMcpServer explicitly.
const entryPath = process.argv[1]?.replace(/\\/g, '/')
const invokedDirectly = Boolean(entryPath && entryPath.endsWith('/mcp.js'))
if (invokedDirectly) {
  void startMcpServer()
}
