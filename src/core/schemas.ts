import { z } from 'zod'

export const positionSchema = z.object({ x: z.number(), y: z.number() })
export const viewportSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() })

export const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal('workflow'),
  position: positionSchema,
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  parentId: z.string().optional(),
  extent: z.literal('parent').optional(),
  data: z.object({
    nodeType: z.string().min(1),
    label: z.string().optional(),
    config: z.record(z.string(), z.unknown()),
    status: z.enum(['idle', 'queued', 'running', 'completed', 'failed', 'cached', 'needs-input', 'cancelled']).optional(),
    statusMessage: z.string().optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
    lastRunId: z.string().optional(),
    previewArtifactId: z.string().optional(),
    freeform: z.boolean().optional()
  }),
  selected: z.boolean().optional(),
  dragging: z.boolean().optional()
})

export const canvasEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().min(1),
  targetHandle: z.string().min(1),
  animated: z.boolean().optional(),
  label: z.string().optional()
})

export const workflowGraphSchema = z.object({
  schemaVersion: z.enum(['1.0', '2.0']),
  id: z.string().min(1),
  revision: z.number().int().nonnegative().default(0),
  name: z.string().min(1),
  description: z.string().optional(),
  mode: z.enum(['free', 'workflow', 'hybrid']),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  viewport: viewportSchema,
  createdAt: z.string(),
  updatedAt: z.string()
})

const graphPatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addNode'), node: canvasNodeSchema }),
  z.object({ op: z.literal('updateNode'), nodeId: z.string(), patch: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('moveNode'), nodeId: z.string(), position: positionSchema }),
  z.object({ op: z.literal('resizeNode'), nodeId: z.string(), width: z.number().positive(), height: z.number().positive() }),
  z.object({ op: z.literal('removeNode'), nodeId: z.string() }),
  z.object({ op: z.literal('connect'), edge: canvasEdgeSchema }),
  z.object({ op: z.literal('disconnect'), edgeId: z.string() }),
  z.object({ op: z.literal('setMode'), mode: z.enum(['free', 'workflow', 'hybrid']) }),
  z.object({ op: z.literal('setViewport'), viewport: viewportSchema }),
  z.object({ op: z.literal('setGraphMetadata'), name: z.string().min(1).optional(), description: z.string().optional() })
])

export const graphPatchSchema = z.object({
  transactionId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(graphPatchOperationSchema).min(1)
})

export const selectionStateSchema = z.object({
  selectedNodeIds: z.array(z.string()),
  selectedEdgeIds: z.array(z.string()),
  updatedAt: z.string()
})

export const promptSpecSchema = z.object({
  subject: z.string().min(1),
  purpose: z.string().optional(),
  composition: z.string().optional(),
  camera: z.string().optional(),
  lighting: z.string().optional(),
  materials: z.array(z.string()).optional(),
  palette: z.array(z.string()).optional(),
  style: z.string().optional(),
  textRequirements: z.array(z.string()).optional(),
  preserve: z.array(z.string()).optional(),
  avoid: z.array(z.string()).optional(),
  aspectRatio: z.string().optional(),
  finalPrompt: z.string().min(1)
})

export const evaluationReportSchema = z.object({
  decision: z.enum(['pass', 'retry', 'manual']),
  selectedIndex: z.number().int().nonnegative(),
  score: z.number().min(0).max(100),
  issues: z.array(z.object({
    code: z.string(),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string()
  })),
  repairPrompt: z.string().optional(),
  technicalScore: z.number().min(0).max(100).optional(),
  semanticScore: z.number().min(0).max(100).optional(),
  reviewer: z.enum(['technical', 'agent', 'hybrid']).optional()
})
