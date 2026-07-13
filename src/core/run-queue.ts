import { EventEmitter } from 'node:events'
import { nanoid } from 'nanoid'
import type { RuntimeConfig } from './config.js'
import type { RunEvent, WorkflowRun } from './types.js'
import { WorkflowRunner } from './runner.js'
import { WorkspaceStorage } from './storage.js'
import { nowIso } from './utils.js'

export class RunQueue extends EventEmitter {
  readonly workerId = `worker-${process.pid}-${nanoid(6)}`
  private timer?: NodeJS.Timeout
  private recoveryTimer?: NodeJS.Timeout
  private stopped = true
  private active = 0
  private lastRecoveryAt = 0

  constructor(private readonly storage: WorkspaceStorage, private readonly runner: WorkflowRunner, private readonly config: RuntimeConfig) {
    super()
    runner.on('event', (event: RunEvent) => this.emit('event', event))
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => void this.tick(), 250)
    this.timer.unref()
    this.recoveryTimer = setInterval(() => void this.recover().catch(() => undefined), 10_000)
    this.recoveryTimer.unref()
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.recoveryTimer) clearInterval(this.recoveryTimer)
    this.timer = undefined
    this.recoveryTimer = undefined
  }

  async enqueue(targetNodeId?: string, graphId = 'main'): Promise<WorkflowRun> {
    const graph = await this.storage.loadGraph(graphId)
    const run = await this.storage.enqueueRun(graph, targetNodeId)
    const event: RunEvent = { type: 'run-queued', runId: run.id, message: targetNodeId ? `Queued run to node ${targetNodeId}.` : 'Queued workflow run.', timestamp: nowIso() }
    await this.storage.appendRunEvent(event); this.emit('event', event)
    void this.tick()
    return run
  }

  async cancel(runId: string): Promise<boolean> { return this.runner.cancel(runId) }

  private async recover(): Promise<void> {
    const now = Date.now()
    if (now - this.lastRecoveryAt < 10_000) return
    this.lastRecoveryAt = now
    const recovered = await this.storage.recoverExpiredRuns()
    if (recovered > 0) {
      this.emit('event', { type: 'run-recovered', message: `Recovered ${recovered} expired run lease(s).`, timestamp: nowIso() })
      void this.tick()
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    while (this.active < this.config.concurrency) {
      const run = await this.storage.claimNextRun(this.workerId, this.config.leaseSeconds)
      if (!run) break
      this.active += 1
      void this.executeClaim(run).finally(() => { this.active -= 1; void this.tick() })
    }
  }

  private async executeClaim(run: WorkflowRun): Promise<void> {
    const heartbeat = setInterval(() => void this.storage.heartbeatRun(run.id, this.workerId, this.config.leaseSeconds), Math.max(2000, this.config.leaseSeconds * 400))
    heartbeat.unref()
    const cancellationWatch = setInterval(async () => {
      const latest = await this.storage.loadRun(run.id)
      if (latest?.status === 'cancelled') await this.runner.cancel(run.id)
    }, 300)
    cancellationWatch.unref()
    try { await this.runner.execute(run, this.workerId) }
    finally { clearInterval(heartbeat); clearInterval(cancellationWatch) }
  }
}
