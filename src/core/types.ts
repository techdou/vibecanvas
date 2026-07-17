export type PortType =
  | 'Text'
  | 'PromptSpec'
  | 'Image'
  | 'ImageSet'
  | 'ImageArray'
  | 'Mask'
  | 'Annotation'
  | 'AspectRatio'
  | 'EvaluationReport'
  | 'ArtifactRef'
  | 'Metadata'
  | 'Boolean'
  | 'Number'
  | 'Any'

export type NodeStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cached' | 'needs-input' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs-input'
export type ArtifactStatus = 'draft' | 'candidate' | 'selected' | 'final' | 'archived'

export interface XYPosition { x: number; y: number }
export interface Viewport { x: number; y: number; zoom: number }

export interface PromptSpec {
  subject: string
  purpose?: string
  composition?: string
  camera?: string
  lighting?: string
  materials?: string[]
  palette?: string[]
  style?: string
  textRequirements?: string[]
  preserve?: string[]
  avoid?: string[]
  aspectRatio?: string
  finalPrompt: string
}

export interface ArtifactRef {
  id: string
  kind: 'image' | 'mask' | 'annotation' | 'json' | 'text'
  status: ArtifactStatus
  filePath: string
  url: string
  mimeType: string
  fileName: string
  sha256: string
  sizeBytes: number
  width?: number
  height?: number
  parentArtifactIds: string[]
  runId?: string
  nodeId?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface EvaluationIssue {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface EvaluationReport {
  decision: 'pass' | 'retry' | 'manual'
  selectedIndex: number
  score: number
  issues: EvaluationIssue[]
  repairPrompt?: string
  technicalScore?: number
  semanticScore?: number
  reviewer?: 'technical' | 'agent' | 'hybrid'
}

export interface PortDefinition {
  id: string
  label: string
  type: PortType
  required?: boolean
  multiple?: boolean
  description?: string
}

export interface ConfigFieldDefinition {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'image' | 'json'
  default?: unknown
  options?: Array<{ label: string; value: string | number | boolean }>
  min?: number
  max?: number
  step?: number
  description?: string
}

export interface NodeDefinition {
  type: string
  version: string
  label: string
  category: 'input' | 'agent' | 'generation' | 'processing' | 'control' | 'output' | 'canvas' | 'workflow'
  description: string
  inputs: PortDefinition[]
  outputs: PortDefinition[]
  configFields: ConfigFieldDefinition[]
  defaultSize?: { width: number; height: number }
}

export interface CanvasNodeData {
  [key: string]: unknown
  nodeType: string
  label?: string
  config: Record<string, unknown>
  status?: NodeStatus
  statusMessage?: string
  outputs?: Record<string, unknown>
  lastRunId?: string
  previewArtifactId?: string
  freeform?: boolean
}

export interface CanvasNode {
  id: string
  type: 'workflow'
  position: XYPosition
  width?: number
  height?: number
  parentId?: string
  extent?: 'parent'
  data: CanvasNodeData
  selected?: boolean
  dragging?: boolean
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  animated?: boolean
  label?: string
}

export interface WorkflowGraph {
  schemaVersion: '1.0' | '2.0'
  id: string
  revision: number
  name: string
  description?: string
  mode: 'free' | 'workflow' | 'hybrid'
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: Viewport
  createdAt: string
  updatedAt: string
}

export type GraphPatchOperation =
  | { op: 'addNode'; node: CanvasNode }
  | { op: 'updateNode'; nodeId: string; patch: Partial<CanvasNodeData> }
  | { op: 'moveNode'; nodeId: string; position: XYPosition }
  | { op: 'resizeNode'; nodeId: string; width: number; height: number }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'connect'; edge: CanvasEdge }
  | { op: 'disconnect'; edgeId: string }
  | { op: 'setMode'; mode: WorkflowGraph['mode'] }
  | { op: 'setViewport'; viewport: Viewport }
  | { op: 'setGraphMetadata'; name?: string; description?: string }

export interface GraphPatch {
  transactionId: string
  baseRevision: number
  operations: GraphPatchOperation[]
}

export interface ValidationProblem {
  code: string
  message: string
  nodeId?: string
  edgeId?: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  valid: boolean
  problems: ValidationProblem[]
  executionOrder: string[]
}

export interface NodeRunRecord {
  nodeId: string
  nodeType: string
  status: NodeStatus
  startedAt?: string
  completedAt?: string
  cacheKey?: string
  outputs?: Record<string, unknown>
  error?: string
  durationMs?: number
  estimatedCostUsd?: number
  actualCostUsd?: number
  attempt?: number
}

export interface WorkflowRun {
  id: string
  graphId: string
  graphRevision: number
  graphSnapshot: WorkflowGraph
  status: RunStatus
  targetNodeId?: string
  queuedAt: string
  startedAt?: string
  completedAt?: string
  nodeRuns: Record<string, NodeRunRecord>
  error?: string
  attempts: number
  maxAttempts: number
  estimatedCostUsd: number
  actualCostUsd: number
  workerId?: string
  lockExpiresAt?: string
  createdAt: string
  updatedAt: string
}

export interface SelectionState {
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  updatedAt: string
}

export interface WorkspaceContext {
  projectDir: string
  dataDir: string
  databaseFile: string
  artifactsDir: string
  runsDir: string
  database: { journalMode: string; userVersion: number; foreignKeys: boolean }
  graph: {
    id: string
    revision: number
    name: string
    mode: WorkflowGraph['mode']
    nodeCount: number
    edgeCount: number
  }
  selection: SelectionState
}

export interface RunEvent {
  type:
    | 'run-queued'
    | 'run-started'
    | 'node-started'
    | 'node-completed'
    | 'node-failed'
    | 'node-needs-input'
    | 'run-completed'
    | 'run-failed'
    | 'run-cancelled'
    | 'run-recovered'
    | 'graph-updated'
    | 'artifact-updated'
  runId?: string
  nodeId?: string
  message?: string
  payload?: unknown
  timestamp: string
}

export interface ProviderCapabilities {
  textToImage: boolean
  imageToImage: boolean
  multiReference: boolean
  maskEdit: boolean
  customSize: boolean
  transparentBackground: boolean
  batchN: boolean
  responseFormats: string[]
  maxReferences: number
  maxCandidates: number
}

export interface ProviderCostTable {
  low: number
  medium: number
  high: number
  auto: number
  editMultiplier: number
}

export interface ImageProviderProfile {
  id: string
  label: string
  apiKey: string
  baseUrl: string
  model: string
  generatePath: string
  editPath: string
  timeoutMs: number
  maxRetries: number
  editImageField: string
  outputFormat: string
  headers: Record<string, string>
  downloadHeaders: Record<string, string>
  extraJson: Record<string, unknown>
  allowPrivateImageUrls: boolean
  allowedImageHosts: string[]
  capabilities: ProviderCapabilities
  costs: ProviderCostTable
}

/**
 * LLM provider profile. Consumed by the Prompt Architect and Vision Review nodes
 * to talk to an external reasoning service. Mirrors src/core/llm-provider.ts.
 */
export interface LLMProfile {
  provider: 'openai-chat' | 'opencode-session' | 'fallback'
  baseUrl?: string
  apiKey?: string
  model?: string
  sessionId?: string
  username?: string
  password?: string
  headers?: Record<string, string>
  requestTimeoutMs?: number
  maxRetries?: number
}

export interface VibeCanvasConfigFile {
  version: 1
  activeProviderId: string
  providers: Record<string, ImageProviderProfile>
  /** Pluggable LLM profiles for the Prompt Architect and Vision Review nodes. */
  llm: {
    architect: LLMProfile
    reviewer: LLMProfile
  }
  runtime: {
    host: string
    port: number
    concurrency: number
    leaseSeconds: number
  }
}

export interface TemplateRecord {
  id: string
  name: string
  description: string
  category: string
  graph: WorkflowGraph
  builtIn: boolean
  createdAt: string
  updatedAt: string
}

export interface ArtifactLineage {
  artifact: ArtifactRef
  ancestors: ArtifactRef[]
  descendants: ArtifactRef[]
}
