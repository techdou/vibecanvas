import { describe, expect, it } from 'vitest'
import { applyGraphPatch, executionNodeIds, RevisionConflictError, validateGraph } from '../src/core/graph.js'
import { createStarterGraph } from '../src/core/templates.js'

describe('graph validation and transactional patches', () => {
  it('accepts the starter graph and excludes an isolated freeform note from execution', () => {
    const graph = createStarterGraph()
    const result = validateGraph(graph)
    expect(result.valid).toBe(true)
    const ids = executionNodeIds(graph)
    const note = graph.nodes.find((node) => node.data.nodeType === 'canvas.note')!
    const review = graph.nodes.find((node) => node.data.nodeType === 'review.quality')!
    expect(ids.has(note.id)).toBe(false)
    expect(ids.has(review.id)).toBe(true)
  })

  it('rejects cycles', () => {
    const graph = createStarterGraph()
    const first = graph.nodes[0]
    const last = graph.nodes.find((node) => node.data.nodeType === 'output.canvas')!
    graph.edges.push({ id: 'cycle', source: last.id, target: first.id, sourceHandle: 'artifact', targetHandle: 'brief' })
    const result = validateGraph(graph)
    expect(result.valid).toBe(false)
    expect(result.problems.some((problem) => problem.code === 'cycle')).toBe(true)
  })

  it('rejects incompatible ports', () => {
    const graph = createStarterGraph()
    const ratio = graph.nodes.find((node) => node.data.nodeType === 'utility.aspect-ratio')!
    const prompt = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    graph.edges.push({ id: 'bad-type', source: ratio.id, target: prompt.id, sourceHandle: 'ratio', targetHandle: 'brief' })
    const result = validateGraph(graph)
    expect(result.valid).toBe(false)
    expect(result.problems.some((problem) => problem.code === 'type-mismatch')).toBe(true)
  })

  it('applies a revision-controlled atomic patch without mutating the source', () => {
    const graph = createStarterGraph()
    const node = graph.nodes[0]
    const next = applyGraphPatch(graph, {
      transactionId: 'tx-1',
      baseRevision: graph.revision,
      operations: [{ op: 'updateNode', nodeId: node.id, patch: { config: { text: 'Updated brief' } } }]
    })
    expect(next.nodes[0].data.config.text).toBe('Updated brief')
    expect(graph.nodes[0].data.config.text).not.toBe('Updated brief')
  })

  it('rejects a stale base revision', () => {
    const graph = createStarterGraph()
    expect(() => applyGraphPatch(graph, { transactionId: 'stale', baseRevision: graph.revision + 1, operations: [{ op: 'setMode', mode: 'workflow' }] }))
      .toThrow(RevisionConflictError)
  })

  it('rejects an invalid target before execution planning', () => {
    const graph = createStarterGraph()
    expect(() => executionNodeIds(graph, 'missing-node')).toThrow(/Target node not found/)
  })
})
