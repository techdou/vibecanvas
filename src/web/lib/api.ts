import type {
  ArtifactLineage, ArtifactRef, GraphPatch, NodeDefinition, SelectionState, TemplateRecord,
  ValidationResult, VibeCanvasConfigFile, WorkflowGraph, WorkflowRun
} from '../../core/types.js'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `${response.status} ${response.statusText}`) as Error & { code?: string; currentRevision?: number }
    error.code = data?.code; error.currentRevision = data?.currentRevision
    throw error
  }
  return data as T
}

export const api = {
  health: () => request<{ ok: boolean; version: string; imageConfigured: boolean; projectDir: string; configFile: string; providerId: string }>('/api/health'),
  getGraph: () => request<WorkflowGraph>('/api/graph'),
  saveGraph: (graph: WorkflowGraph) => request<WorkflowGraph>('/api/graph', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(graph) }),
  patchGraph: (patch: GraphPatch) => request<WorkflowGraph>('/api/graph/patch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  resetGraph: () => request<WorkflowGraph>('/api/graph/reset', { method: 'POST' }),
  validateGraph: (graph: WorkflowGraph) => request<ValidationResult>('/api/graph/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(graph) }),
  getRevisions: () => request<Array<{ revision: number; transactionId?: string; createdAt: string }>>('/api/graph/revisions'),
  restoreRevision: (revision: number) => request<WorkflowGraph>(`/api/graph/revisions/${revision}/restore`, { method: 'POST' }),
  getRegistry: () => request<NodeDefinition[]>('/api/node-registry'),
  getArtifacts: (limit = 500, status?: string, runId?: string, kind?: string) => request<ArtifactRef[]>(`/api/artifacts?limit=${limit}${status ? `&status=${status}` : ''}${runId ? `&runId=${runId}` : ''}${kind ? `&kind=${kind}` : ''}`),
  getLineage: (artifactId: string) => request<ArtifactLineage>(`/api/artifacts/${artifactId}/lineage`),
  setArtifactStatus: (artifactId: string, status: ArtifactRef['status']) => request<ArtifactRef>(`/api/artifacts/${artifactId}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }),
  getRuns: () => request<WorkflowRun[]>('/api/runs'),
  getRun: (runId: string) => request<WorkflowRun>(`/api/runs/${runId}`),
  run: (targetNodeId?: string) => request<{ accepted: boolean; runId: string; status: string }>('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetNodeId }) }),
  cancelRun: (runId: string) => request<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),
  selectCandidate: (runId: string, nodeId: string, artifactId: string) => request(`/api/runs/${runId}/nodes/${nodeId}/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactId }) }),
  saveSelection: (selection: Omit<SelectionState, 'updatedAt'>) => request<SelectionState>('/api/selection', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) }),
  upload: async (file: File | Blob, role = 'reference', kind: ArtifactRef['kind'] = 'image', sourceArtifactId?: string, fileName?: string, notes?: string, parentArtifactIds?: string[]) => {
    const form = new FormData(); form.set('file', file, fileName || (file instanceof File ? file.name : `${kind}.png`)); form.set('role', role); form.set('kind', kind)
    if (sourceArtifactId) form.set('sourceArtifactId', sourceArtifactId)
    if (notes) form.set('notes', notes)
    if (parentArtifactIds && parentArtifactIds.length) form.set('parentArtifactIds', parentArtifactIds.join(','))
    return request<ArtifactRef>('/api/uploads', { method: 'POST', body: form })
  },
  placeArtifact: (artifactId: string, position?: { x: number; y: number }) => request<{ node: unknown; graph: WorkflowGraph }>(`/api/artifacts/${artifactId}/place`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position }) }),
  getTemplates: () => request<TemplateRecord[]>('/api/templates'),
  createTemplate: (payload: { name: string; description?: string; category?: string; graph?: WorkflowGraph }) => request<TemplateRecord>('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  applyTemplate: (id: string) => request<WorkflowGraph>(`/api/templates/${id}/apply`, { method: 'POST' }),
  getConfig: () => request<VibeCanvasConfigFile>('/api/config'),
  saveProvider: (id: string, profile: Record<string, unknown>) => request<{ config: VibeCanvasConfigFile; restartRequired: boolean }>(`/api/config/providers/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }),
  getProviderCapabilities: () => request<{ providerId: string; model: string; configured: boolean; capabilities: Record<string, unknown>; costs: Record<string, number> }>('/api/provider/capabilities')
}
