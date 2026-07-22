import { describe, expect, it } from 'vitest'
import { applyGraphPatch, validateGraph } from '../src/core/graph.js'
import { createStarterGraph } from '../src/core/templates.js'
import { ensureImageEditWorkflow } from '../src/web/lib/edit-workflow.js'

describe('hidden image edit workflow', () => {
  it('creates one valid isolated edit pipeline in a single patch', () => {
    const graph = createStarterGraph()
    let sequence = 0
    const prepared = ensureImageEditWorkflow(graph, {
      sourceArtifactId: 'source-1',
      annotationArtifactId: 'annotation-1',
      brief: '把箭头指向的眼睛改成蓝色。',
      quality: 'high',
      candidateCount: 2,
      idFactory: () => `edit-${++sequence}`
    })
    const next = applyGraphPatch(graph, {
      transactionId: 'create-hidden-edit',
      baseRevision: graph.revision,
      operations: prepared.operations
    })

    expect(validateGraph(next).valid).toBe(true)
    expect(prepared.created).toBe(true)
    expect(prepared.operations.filter((operation) => operation.op === 'addNode')).toHaveLength(5)
    expect(prepared.operations.filter((operation) => operation.op === 'connect')).toHaveLength(5)
    expect(next.nodes.find((node) => node.id === prepared.nodeIds.edit)?.data.config.candidateCount).toBe(2)
  })

  it('reuses the existing hidden pipeline and only updates its inputs', () => {
    const graph = createStarterGraph()
    let sequence = 0
    const first = ensureImageEditWorkflow(graph, {
      sourceArtifactId: 'source-1', annotationArtifactId: 'annotation-1', brief: 'first',
      quality: 'medium', candidateCount: 1, idFactory: () => `edit-${++sequence}`
    })
    const next = applyGraphPatch(graph, {
      transactionId: 'create-hidden-edit', baseRevision: graph.revision, operations: first.operations
    })
    const second = ensureImageEditWorkflow(next, {
      sourceArtifactId: 'source-2', annotationArtifactId: 'annotation-2', brief: 'second',
      quality: 'high', candidateCount: 3, idFactory: () => `unexpected-${++sequence}`
    })

    expect(second.created).toBe(false)
    expect(second.nodeIds).toEqual(first.nodeIds)
    expect(second.operations.every((operation) => operation.op === 'updateNode')).toBe(true)
    expect(second.operations).toHaveLength(4)
  })
})
