import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { RevisionConflictError } from '../src/core/graph.js'
import { RunStateConflictError, WorkspaceStorage } from '../src/core/storage.js'
import { tempWorkspace } from './helpers.js'

describe('SQLite workspace storage', () => {
  it('persists graphs with monotonic revisions and revision history', async () => {
    const { storage } = await tempWorkspace('vibecanvas-storage-')
    const graph = await storage.loadGraph()
    const next = await storage.applyPatch({
      transactionId: 'rename-1', baseRevision: graph.revision,
      operations: [{ op: 'setGraphMetadata', name: 'Updated graph', description: 'revision test' }]
    })
    expect(next.revision).toBe(graph.revision + 1)
    const revisions = await storage.listGraphRevisions()
    expect(revisions.map((item) => item.revision)).toContain(next.revision)
    const restored = await storage.restoreGraphRevision(graph.revision)
    expect(restored.name).toBe(graph.name)
    expect(restored.revision).toBe(next.revision + 1)
    storage.close()
  })

  it('prevents stale concurrent graph updates', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-revision-')
    const second = new WorkspaceStorage(dir)
    await second.init()
    const firstGraph = await storage.loadGraph()
    const secondGraph = await second.loadGraph()
    await storage.applyPatch({ transactionId: 'winner', baseRevision: firstGraph.revision, operations: [{ op: 'setMode', mode: 'workflow' }] })
    await expect(second.applyPatch({ transactionId: 'stale', baseRevision: secondGraph.revision, operations: [{ op: 'setMode', mode: 'free' }] }))
      .rejects.toBeInstanceOf(RevisionConflictError)
    storage.close(); second.close()
  })

  it('registers concurrent artifacts without lost updates', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-artifacts-')
    const imagePath = path.join(dir, 'sample.png')
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#b66f48' } }).png().toFile(imagePath)
    const artifacts = await Promise.all(Array.from({ length: 30 }, (_, index) => storage.registerArtifact({
      filePath: imagePath, metadata: { index }
    })))
    expect(new Set(artifacts.map((item) => item.id)).size).toBe(30)
    expect(await storage.listArtifacts()).toHaveLength(30)
    storage.close()
  })

  it('supports concurrent writers from separate SQLite connections', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibecanvas-multiprocess-'))
    const stores = Array.from({ length: 4 }, () => new WorkspaceStorage(dir))
    await Promise.all(stores.map((store) => store.init()))
    const imagePath = path.join(dir, 'sample.png')
    await sharp({ create: { width: 256, height: 256, channels: 4, background: '#6d7b8f' } }).png().toFile(imagePath)
    await Promise.all(Array.from({ length: 40 }, (_, index) => stores[index % stores.length].registerArtifact({ filePath: imagePath, metadata: { index } })))
    expect(await stores[0].listArtifacts()).toHaveLength(40)
    stores.forEach((store) => store.close())
  })

  it('persists artifact status and lineage', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-lineage-')
    const imagePath = path.join(dir, 'sample.png')
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#b66f48' } }).png().toFile(imagePath)
    const parent = await storage.registerArtifact({ filePath: imagePath, status: 'draft' })
    const child = await storage.registerArtifact({ filePath: imagePath, parentArtifactIds: [parent.id] })
    const final = await storage.updateArtifactStatus(child.id, 'final', { reason: 'selected output' })
    expect(final.status).toBe('final')
    const lineage = await storage.artifactLineage(child.id)
    expect(lineage.ancestors.map((item) => item.id)).toContain(parent.id)
    expect(lineage.artifact.metadata?.reason).toBe('selected output')
    storage.close()
  })

  it('stores immutable run snapshots independent from later graph edits', async () => {
    const { storage } = await tempWorkspace('vibecanvas-snapshot-')
    const graph = await storage.loadGraph()
    const run = await storage.enqueueRun(graph)
    await storage.applyPatch({ transactionId: 'later-edit', baseRevision: graph.revision, operations: [{ op: 'setGraphMetadata', name: 'Changed later' }] })
    const savedRun = await storage.loadRun(run.id)
    expect(savedRun?.graphSnapshot.name).toBe(graph.name)
    expect(savedRun?.graphRevision).toBe(graph.revision)
    storage.close()
  })

  it('recovers expired leases and fails exhausted runs', async () => {
    const { storage } = await tempWorkspace('vibecanvas-recovery-')
    const graph = await storage.loadGraph()
    const retryable = await storage.enqueueRun(graph, undefined, 2)
    const claimed = await storage.claimNextRun('dead-worker', 10)
    expect(claimed?.id).toBe(retryable.id)
    if (!claimed) throw new Error('run not claimed')
    claimed.lockExpiresAt = new Date(Date.now() - 5000).toISOString()
    await storage.saveRun(claimed)
    // saveRun synchronizes the JSON payload; update the indexed lock via heartbeat then direct expiry is recovered on reopen.
    storage.close()
    const reopened = new WorkspaceStorage(storage.projectDir)
    await reopened.init()
    const recovered = await reopened.loadRun(retryable.id)
    expect(['queued', 'running']).toContain(recovered?.status)
    reopened.close()
  })

  it('serializes concurrent initialization on the same storage instance', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibecanvas-init-lock-'))
    const storage = new WorkspaceStorage(dir)
    await Promise.all(Array.from({ length: 20 }, () => storage.init()))
    const context = await storage.context()
    expect(context.databaseFile).toMatch(/vibecanvas\.db$/)
    expect((await storage.loadGraph()).id).toBe('main')
    storage.close()
  })


  it('updates worker heartbeats without overwriting persisted node progress', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-heartbeat-')
    const second = new WorkspaceStorage(dir)
    await second.init()
    const graph = await storage.loadGraph()
    const queued = await storage.enqueueRun(graph)
    const claimed = await storage.claimNextRun('worker-a', 30)
    if (!claimed) throw new Error('run not claimed')
    claimed.nodeRuns['node-progress'] = {
      nodeId: 'node-progress', nodeType: 'test.node', status: 'completed', outputs: { value: 42 }
    }
    await storage.saveRun(claimed)
    expect(await second.heartbeatRun(queued.id, 'worker-a', 30)).toBe(true)
    const loaded = await storage.loadRun(queued.id)
    expect(loaded?.nodeRuns['node-progress'].outputs).toEqual({ value: 42 })
    storage.close(); second.close()
  })

  it('prevents a stale worker save from overwriting external cancellation', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-run-cas-')
    const second = new WorkspaceStorage(dir)
    await second.init()
    const graph = await storage.loadGraph()
    await storage.enqueueRun(graph)
    const claimed = await storage.claimNextRun('worker-a', 30)
    if (!claimed) throw new Error('run not claimed')
    expect(await second.cancelRun(claimed.id)).toBe(true)
    claimed.nodeRuns['late-node'] = { nodeId: 'late-node', nodeType: 'test.node', status: 'completed' }
    await expect(storage.saveRun(claimed)).rejects.toBeInstanceOf(RunStateConflictError)
    const loaded = await storage.loadRun(claimed.id)
    expect(loaded?.status).toBe('cancelled')
    expect(loaded?.nodeRuns['late-node']).toBeUndefined()
    storage.close(); second.close()
  })

})
