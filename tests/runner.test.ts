import { createServer } from 'node:http'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowRunner } from '../src/core/runner.js'
import { RunQueue } from '../src/core/run-queue.js'
import { createStarterGraph } from '../src/core/templates.js'
import type { CanvasEdge, CanvasNode, WorkflowGraph } from '../src/core/types.js'
import { nowIso } from '../src/core/utils.js'
import { makeProfile, makeRuntimeConfig, tempWorkspace, waitForRun } from './helpers.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  )
})

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return address.port
}

function imageBuffer(color = '#a96b49') {
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: color
    }
  }).png().toBuffer()
}

describe('workflow runner and queue', () => {
  it('uses the configured OpenAI-compatible LLM to produce a PromptSpec', async () => {
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                subject: 'Structured subject',
                finalPrompt: 'Structured final prompt',
                style: 'editorial'
              })
            }
          }]
        }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-llm-structured-')
    const config = makeRuntimeConfig(dir, {
      llm: {
        architect: { provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-architect' },
        reviewer: { provider: 'fallback' }
      }
    })
    const graph = createStarterGraph()
    const promptNode = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    const run = await storage.enqueueRun(graph, promptNode.id)
    const completed = await new WorkflowRunner(storage, config).execute(run, 'test-worker')

    expect(completed.status).toBe('completed')
    expect(completed.nodeRuns[promptNode.id].outputs?.promptSpec).toMatchObject({
      subject: 'Structured subject',
      finalPrompt: 'Structured final prompt'
    })
    storage.close()
  })

  it('attaches candidate images when calling the LLM vision review endpoint', async () => {
    const image = await imageBuffer()
    let chatRequests = 0
    let visionImageCount = 0
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          data: [
            { b64_json: image.toString('base64') },
            { b64_json: image.toString('base64') }
          ]
        }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = ''
        for await (const chunk of req) body += chunk
        const parsed = JSON.parse(body) as { messages: Array<{ content: unknown }> }
        chatRequests += 1
        const userMessage = parsed.messages.find((message) => typeof message.content !== 'string')
        if (userMessage && Array.isArray(userMessage.content)) {
          visionImageCount = userMessage.content.filter((part: { type?: string }) => part.type === 'image_url').length
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify(chatRequests === 1
                ? { subject: 'IP character', finalPrompt: 'Generate an IP character' }
                : { decision: 'pass', selectedIndex: 1, score: 92, issues: [] })
            }
          }]
        }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-vision-')
    const config = makeRuntimeConfig(dir, {
      image: makeProfile({
        apiKey: 'test',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        maxRetries: 0
      }),
      llm: {
        architect: { provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-architect' },
        reviewer: { provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-vision' }
      }
    })
    const graph = createStarterGraph()
    const review = graph.nodes.find((node) => node.data.nodeType === 'review.quality')!
    const generation = graph.nodes.find((node) => node.data.nodeType === 'image.generate')!
    generation.data.config.candidateCount = 2
    const run = await storage.enqueueRun(graph, review.id)
    const completed = await new WorkflowRunner(storage, config).execute(run, 'vision-worker')

    expect(completed.status).toBe('completed')
    expect(visionImageCount).toBe(2)
    expect(completed.nodeRuns[review.id].outputs?.report).toMatchObject({
      reviewer: 'hybrid',
      selectedIndex: 1,
      semanticScore: 92
    })
    storage.close()
  })

  it('propagates cancellation through the image request and does not persist outputs', async () => {
    const image = await imageBuffer()
    const server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 900))
        if (!res.destroyed) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
        }
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-run-cancel-')
    const graph = createStarterGraph()
    const prompt = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    prompt.data.config.llmEnabled = false
    const generation = graph.nodes.find((node) => node.data.nodeType === 'image.generate')!
    generation.data.config.candidateCount = 1
    const config = makeRuntimeConfig(dir, {
      image: makeProfile({
        apiKey: 'test',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        maxRetries: 0
      })
    })
    const runner = new WorkflowRunner(storage, config)
    const run = await storage.enqueueRun(graph, generation.id)
    const execution = runner.execute(run, 'cancel-worker')
    const cancellation = new Promise<boolean>((resolve) => {
      setTimeout(() => void runner.cancel(run.id).then(resolve), 100)
    })
    const cancelled = await execution
    await cancellation

    expect(cancelled.status).toBe('cancelled')
    expect(await storage.listArtifacts()).toHaveLength(0)
    storage.close()
  })

  it('validates invalid targets before queuing', async () => {
    const { storage } = await tempWorkspace('vibecanvas-invalid-target-')
    const graph = await storage.loadGraph()
    await expect(storage.enqueueRun(graph, 'missing-node')).rejects.toThrow(/Target node not found/)
    storage.close()
  })

  it('replaces the requested canvas image in place and persists final status', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-replace-')
    const filePath = path.join(dir, 'image.png')
    await sharp(await imageBuffer('#4c87a9')).toFile(filePath)
    const artifact = await storage.registerArtifact({ filePath, status: 'candidate' })
    const now = nowIso()
    const source: CanvasNode = {
      id: 'source-image',
      type: 'workflow',
      position: { x: 120, y: 200 },
      width: 360,
      height: 360,
      data: {
        nodeType: 'canvas.image',
        config: { artifactId: artifact.id },
        status: 'completed',
        previewArtifactId: artifact.id,
        freeform: false
      }
    }
    const output: CanvasNode = {
      id: 'output',
      type: 'workflow',
      position: { x: 650, y: 200 },
      data: {
        nodeType: 'output.canvas',
        config: {
          placement: 'replace',
          replaceNodeId: source.id,
          markFinal: true
        },
        status: 'idle'
      }
    }
    const edge: CanvasEdge = {
      id: 'edge-source-output',
      source: source.id,
      sourceHandle: 'image',
      target: output.id,
      targetHandle: 'image'
    }
    const graph: WorkflowGraph = {
      schemaVersion: '2.0',
      id: 'main',
      revision: 0,
      name: 'Replace test',
      description: '',
      mode: 'workflow',
      nodes: [source, output],
      edges: [edge],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now
    }
    const current = await storage.loadGraph()
    graph.revision = current.revision
    graph.createdAt = current.createdAt
    const saved = await storage.saveGraph(graph, current.revision, 'replace-test')
    const run = await storage.enqueueRun(saved)
    const completed = await new WorkflowRunner(storage, makeRuntimeConfig(dir)).execute(run, 'replace-worker')

    expect(completed.status).toBe('completed')
    const updated = await storage.loadGraph()
    const replaced = updated.nodes.find((node) => node.id === source.id)!
    expect(replaced.position).toEqual({ x: 120, y: 200 })
    expect(replaced.data.config.generatedByRunId).toBe(run.id)
    expect((await storage.getArtifact(artifact.id))?.status).toBe('final')
    storage.close()
  })

  it('queues runs asynchronously and reports progress through persisted events', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-queue-')
    const graph = await storage.loadGraph()
    const prompt = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    prompt.data.config.llmEnabled = false
    await storage.saveGraph(graph, graph.revision, 'disable-opencode')
    const config = makeRuntimeConfig(dir)
    const runner = new WorkflowRunner(storage, config)
    const queue = new RunQueue(storage, runner, config)
    queue.start()
    const accepted = await queue.enqueue(prompt.id)

    expect(accepted.status).toBe('queued')
    const completed = await waitForRun(storage, accepted.id)
    expect(completed.status).toBe('completed')
    const events = await storage.listRunEvents(accepted.id)
    expect(events.map((item) => item.event.type)).toEqual(
      expect.arrayContaining(['run-queued', 'run-started', 'run-completed'])
    )
    queue.stop()
    storage.close()
  })

  it('cancels an in-flight LLM request via AbortController without leaking the cancellation', async () => {
    let llmStarted = 0
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        llmStarted += 1
        // Hold the response long enough for the cancellation to fire.
        await new Promise((resolve) => setTimeout(resolve, 900))
        if (!res.destroyed) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ subject: 'late', finalPrompt: 'late' }) } }]
          }))
        }
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-llm-cancel-')
    const graph = createStarterGraph()
    const promptNode = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    const runner = new WorkflowRunner(storage, makeRuntimeConfig(dir, {
      llm: {
        architect: { provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-architect' },
        reviewer: { provider: 'fallback' }
      }
    }))
    const run = await storage.enqueueRun(graph, promptNode.id)
    const execution = runner.execute(run, 'llm-cancel-worker')
    let cancelPromise: Promise<boolean> | undefined
    setTimeout(() => { cancelPromise = runner.cancel(run.id) }, 80)
    const cancelled = await execution
    while (!cancelPromise) await new Promise((resolve) => setTimeout(resolve, 5))
    await cancelPromise

    expect(cancelled.status).toBe('cancelled')
    // The LLM endpoint was reached (request started), proving the run reached the LLM call.
    expect(llmStarted).toBeGreaterThanOrEqual(1)
    storage.close()
  })

  it('executes a saved template as an isolated subworkflow run snapshot', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-subflow-')
    const childGraph = createStarterGraph()
    childGraph.name = 'Child prompt workflow'
    const childPrompt = childGraph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    childPrompt.data.config.llmEnabled = false
    const childBrief = childGraph.nodes.find((node) => node.data.nodeType === 'input.brief')!
    childGraph.nodes = [childBrief, childPrompt]
    childGraph.edges = childGraph.edges.filter(
      (edge) => edge.source === childBrief.id && edge.target === childPrompt.id
    )
    await storage.saveTemplate({
      id: 'child-prompt',
      name: 'Child prompt',
      description: 'Subworkflow test',
      category: 'test',
      graph: childGraph,
      builtIn: false
    })

    const now = nowIso()
    const brief: CanvasNode = {
      id: 'parent-brief',
      type: 'workflow',
      position: { x: 0, y: 0 },
      data: {
        nodeType: 'input.brief',
        config: { text: 'Injected subworkflow brief' },
        status: 'idle'
      }
    }
    const subflow: CanvasNode = {
      id: 'parent-subflow',
      type: 'workflow',
      position: { x: 400, y: 0 },
      data: {
        nodeType: 'workflow.subflow',
        config: {
          templateId: 'child-prompt',
          inputNodeId: childBrief.id,
          outputNodeId: childPrompt.id
        },
        status: 'idle'
      }
    }
    const edge: CanvasEdge = {
      id: 'parent-edge',
      source: brief.id,
      sourceHandle: 'text',
      target: subflow.id,
      targetHandle: 'input'
    }
    const parent: WorkflowGraph = {
      schemaVersion: '2.0',
      id: 'main',
      revision: 0,
      name: 'Parent',
      description: '',
      mode: 'workflow',
      nodes: [brief, subflow],
      edges: [edge],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now
    }
    const current = await storage.loadGraph()
    parent.revision = current.revision
    parent.createdAt = current.createdAt
    const saved = await storage.saveGraph(parent, current.revision, 'subflow-parent')
    const run = await storage.enqueueRun(saved, subflow.id)
    const completed = await new WorkflowRunner(storage, makeRuntimeConfig(dir)).execute(run, 'subflow-worker')

    expect(completed.status).toBe('completed')
    const metadata = completed.nodeRuns[subflow.id].outputs?.metadata as { childRunId: string }
    const childRun = await storage.loadRun(metadata.childRunId)
    expect(childRun?.status).toBe('completed')
    expect(childRun?.nodeRuns[childPrompt.id].outputs?.promptSpec).toMatchObject({
      subject: expect.stringContaining('Injected subworkflow brief')
    })
    storage.close()
  })

  it('persists selected status when a single generated candidate is auto-selected', async () => {
    const image = await imageBuffer('#8c6a52')
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-auto-select-')
    const graph = createStarterGraph()
    const prompt = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    prompt.data.config.llmEnabled = false
    const generation = graph.nodes.find((node) => node.data.nodeType === 'image.generate')!
    generation.data.config.candidateCount = 1
    const review = graph.nodes.find((node) => node.data.nodeType === 'review.quality')!
    review.data.config.reviewMode = 'technical'
    const selector = graph.nodes.find((node) => node.data.nodeType === 'control.human-select')!
    const config = makeRuntimeConfig(dir, {
      image: makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 })
    })
    const run = await storage.enqueueRun(graph, selector.id)
    const completed = await new WorkflowRunner(storage, config).execute(run, 'auto-select-worker')

    expect(completed.status).toBe('completed')
    const artifacts = await storage.listArtifacts()
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].status).toBe('selected')
    expect(completed.nodeRuns[selector.id].outputs?.selected).toMatchObject({ id: artifacts[0].id, status: 'selected' })
    storage.close()
  })

  it('rejects an out-of-range candidate index from the LLM Vision Review', async () => {
    const image = await imageBuffer()
    let chatRequests = 0
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        chatRequests += 1
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify(chatRequests === 1
                ? { subject: 'subject', finalPrompt: 'prompt' }
                : { decision: 'pass', selectedIndex: 9, score: 90, issues: [] })
            }
          }]
        }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-bad-review-index-')
    const graph = createStarterGraph()
    const review = graph.nodes.find((node) => node.data.nodeType === 'review.quality')!
    const config = makeRuntimeConfig(dir, {
      image: makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 }),
      llm: {
        architect: { provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-architect' },
        reviewer: { provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-vision' }
      }
    })
    const run = await storage.enqueueRun(graph, review.id)
    const completed = await new WorkflowRunner(storage, config).execute(run, 'bad-index-worker')

    expect(completed.status).toBe('failed')
    expect(completed.error).toMatch(/but only \d+ images exist/)
    storage.close()
  })

})
