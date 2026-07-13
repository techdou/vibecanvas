import { createServer } from 'node:http'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { WorkflowRunner } from '../src/core/runner.js'
import { RunQueue } from '../src/core/run-queue.js'
import { createStarterGraph } from '../src/core/templates.js'
import type { ArtifactRef } from '../src/core/types.js'
import { makeProfile, makeRuntimeConfig, tempWorkspace, waitForRun } from './helpers.js'

describe('full image workflow', () => {
  it('generates candidates, pauses for visual selection, resumes, finalizes, and places a branchable image', async () => {
    const imageA = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#a96b49' } }).png().toBuffer()
    const imageB = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#4c7d83' } }).png().toBuffer()
    const apiServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: imageA.toString('base64') }, { b64_json: imageB.toString('base64') }] }))
        return
      }
      res.statusCode = 404; res.end()
    })
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', () => resolve()))
    try {
      const address = apiServer.address(); if (!address || typeof address === 'string') throw new Error('No port')
      const { dir, storage } = await tempWorkspace('vibecanvas-full-')
      const graph = createStarterGraph()
      graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!.data.config.useOpenCode = false
      graph.nodes.find((node) => node.data.nodeType === 'review.quality')!.data.config.reviewMode = 'technical'
      graph.nodes.find((node) => node.data.nodeType === 'image.generate')!.data.config.candidateCount = 2
      const current = await storage.loadGraph(); graph.revision = current.revision; graph.createdAt = current.createdAt
      const saved = await storage.saveGraph(graph, current.revision, 'full-workflow')
      const config = makeRuntimeConfig(dir, { image: makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0, costs: { low: 0.01, medium: 0.02, high: 0.04, auto: 0.03, editMultiplier: 1 } }) })
      const runner = new WorkflowRunner(storage, config)
      const initial = await storage.enqueueRun(saved)
      const paused = await runner.execute(initial, 'full-worker')
      expect(paused.status).toBe('needs-input')
      const selector = saved.nodes.find((node) => node.data.nodeType === 'control.human-select')!
      const candidates = paused.nodeRuns[selector.id].outputs?.candidates as ArtifactRef[]
      expect(candidates).toHaveLength(2)

      await storage.resolveRunSelection(paused.id, selector.id, candidates[1].id)
      const queue = new RunQueue(storage, runner, config)
      queue.start()
      const completed = await waitForRun(storage, paused.id, ['completed', 'failed', 'cancelled'], 10000)
      queue.stop()
      expect(completed.status).toBe('completed')
      expect(completed.estimatedCostUsd).toBe(0.08)
      const finalArtifact = await storage.getArtifact(candidates[1].id)
      expect(finalArtifact?.status).toBe('final')
      const savedGraph = await storage.loadGraph()
      const outputImage = savedGraph.nodes.find((node) => node.data.nodeType === 'canvas.image' && node.data.config.generatedByRunId === completed.id)
      expect(outputImage?.data.previewArtifactId).toBe(candidates[1].id)
      expect(outputImage?.data.freeform).toBe(true)
      storage.close()
    } finally {
      await new Promise<void>((resolve) => apiServer.close(() => resolve()))
    }
  })
})
