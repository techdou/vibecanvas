import { afterEach, describe, expect, it } from 'vitest'
import { createVibeCanvasApp, type AppRuntime } from '../src/server/app.js'
import { makeRuntimeConfig, tempWorkspace, waitForRun } from './helpers.js'

const runtimes: AppRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => new Promise<void>((resolve) => runtime.server.close(() => resolve()))))
})

describe('HTTP server', () => {
  it('serves v2 health, SQLite workspace, graph revision, templates, and provider capabilities', async () => {
    const { dir } = await tempWorkspace('vibecanvas-server-')
    const runtime = await createVibeCanvasApp(makeRuntimeConfig(dir))
    runtimes.push(runtime)
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', () => resolve()))
    const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const base = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${base}/api/health`).then((response) => response.json())
    const workspace = await fetch(`${base}/api/workspace`).then((response) => response.json())
    const graph = await fetch(`${base}/api/graph`).then((response) => response.json())
    const templates = await fetch(`${base}/api/templates`).then((response) => response.json())
    const capabilities = await fetch(`${base}/api/provider/capabilities`).then((response) => response.json())
    expect(health).toMatchObject({ ok: true, version: '2.0.0', sqliteWal: true })
    expect(workspace.databaseFile).toMatch(/vibecanvas\.db$/)
    expect(graph.revision).toBeTypeOf('number')
    expect(templates.length).toBeGreaterThanOrEqual(2)
    expect(capabilities.capabilities.textToImage).toBe(true)
  })

  it('returns 409 for stale transactional graph patches', async () => {
    const { dir } = await tempWorkspace('vibecanvas-server-revision-')
    const runtime = await createVibeCanvasApp(makeRuntimeConfig(dir))
    runtimes.push(runtime)
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', () => resolve()))
    const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const base = `http://127.0.0.1:${address.port}`
    const graph = await fetch(`${base}/api/graph`).then((response) => response.json())
    const first = await fetch(`${base}/api/graph/patch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionId: 'first', baseRevision: graph.revision, operations: [{ op: 'setMode', mode: 'workflow' }] }) })
    expect(first.status).toBe(200)
    const stale = await fetch(`${base}/api/graph/patch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionId: 'stale', baseRevision: graph.revision, operations: [{ op: 'setMode', mode: 'free' }] }) })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('accepts workflow runs asynchronously and exposes status/events/cancel endpoints', async () => {
    const { dir } = await tempWorkspace('vibecanvas-server-run-')
    const runtime = await createVibeCanvasApp(makeRuntimeConfig(dir))
    runtimes.push(runtime)
    const graph = await runtime.storage.loadGraph()
    const prompt = graph.nodes.find((node) => node.data.nodeType === 'agent.prompt-architect')!
    prompt.data.config.llmEnabled = false
    await runtime.storage.saveGraph(graph, graph.revision, 'server-run')
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', () => resolve()))
    const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const base = `http://127.0.0.1:${address.port}`
    const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetNodeId: prompt.id }) })
    expect(response.status).toBe(202)
    const accepted = await response.json()
    expect(accepted).toMatchObject({ accepted: true, status: 'queued' })
    const completed = await waitForRun(runtime.storage, accepted.runId)
    expect(completed.status).toBe('completed')
    const events = await fetch(`${base}/api/runs/${accepted.runId}/events`).then((item) => item.json())
    expect(events.length).toBeGreaterThan(0)
  })

  it('rejects a missing run target before it enters the queue', async () => {
    const { dir } = await tempWorkspace('vibecanvas-server-invalid-target-')
    const runtime = await createVibeCanvasApp(makeRuntimeConfig(dir))
    runtimes.push(runtime)
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', () => resolve()))
    const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetNodeId: 'missing-node' })
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_TARGET' })
    expect(await runtime.storage.listRuns()).toHaveLength(0)
  })

})
