import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }
import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import type {
  ArtifactLineage, ArtifactRef, ArtifactStatus, GraphPatch, RunEvent, SelectionState,
  TemplateRecord, WorkflowGraph, WorkflowRun, WorkspaceContext
} from './types.js'
import { workflowGraphSchema } from './schemas.js'
import { applyGraphPatch, RevisionConflictError } from './graph.js'
import { createBuiltInTemplates, createStarterGraph } from './templates.js'
import { ensureDir, nowIso, readJsonFile, sanitizeFileName, sha256 } from './utils.js'

export class RunStateConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'RunStateConflictError' }
}

export class WorkspaceStorage {
  readonly projectDir: string
  readonly dataDir: string
  readonly databaseFile: string
  readonly graphFile: string
  readonly selectionFile: string
  readonly artifactsFile: string
  readonly artifactsDir: string
  readonly uploadsDir: string
  readonly runsDir: string
  readonly cacheDir: string
  readonly exportsDir: string
  private db?: DatabaseSyncType
  private initialized = false
  private initializing?: Promise<void>

  constructor(projectDir = process.env.VIBECANVAS_PROJECT_DIR || process.cwd()) {
    this.projectDir = path.resolve(projectDir)
    this.dataDir = path.join(this.projectDir, '.vibecanvas')
    this.databaseFile = path.join(this.dataDir, 'vibecanvas.db')
    this.graphFile = path.join(this.dataDir, 'graph.json')
    this.selectionFile = path.join(this.dataDir, 'selection.json')
    this.artifactsFile = path.join(this.dataDir, 'artifacts.json')
    this.artifactsDir = path.join(this.dataDir, 'artifacts')
    this.uploadsDir = path.join(this.dataDir, 'uploads')
    this.runsDir = path.join(this.dataDir, 'runs')
    this.cacheDir = path.join(this.dataDir, 'cache')
    this.exportsDir = path.join(this.dataDir, 'exports')
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initializing ??= this.initialize()
    try {
      await this.initializing
    } catch (error) {
      // Clear the rejected promise so a transient failure does not permanently brick the instance.
      this.initializing = undefined
      throw error
    } finally {
      if (this.initialized) this.initializing = undefined
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    await Promise.all([
      ensureDir(this.dataDir), ensureDir(this.artifactsDir), ensureDir(this.uploadsDir),
      ensureDir(this.runsDir), ensureDir(this.cacheDir), ensureDir(this.exportsDir)
    ])
    const db = new DatabaseSync(this.databaseFile)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA user_version=2;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS graphs (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, graph_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_revisions (
        graph_id TEXT NOT NULL, revision INTEGER NOT NULL, graph_json TEXT NOT NULL, transaction_id TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (graph_id, revision)
      );
      CREATE TABLE IF NOT EXISTS selection (
        id INTEGER PRIMARY KEY CHECK (id = 1), selection_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, file_path TEXT NOT NULL, url TEXT NOT NULL,
        mime_type TEXT NOT NULL, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        width INTEGER, height INTEGER, parent_ids_json TEXT NOT NULL, run_id TEXT, node_id TEXT,
        metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, graph_revision INTEGER NOT NULL, target_node_id TEXT,
        status TEXT NOT NULL, queued_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, estimated_cost REAL NOT NULL, actual_cost REAL NOT NULL,
        worker_id TEXT, lock_expires_at TEXT, run_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, queued_at);
      CREATE INDEX IF NOT EXISTS idx_runs_lock ON runs(status, lock_expires_at);
      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
      CREATE TABLE IF NOT EXISTS run_snapshots (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, run_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_snapshots_run ON run_snapshots(run_id, seq);
      CREATE TABLE IF NOT EXISTS cache (
        cache_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
        graph_json TEXT NOT NULL, built_in INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    this.db = db
    await this.migrateLegacyFiles()
    this.seedBuiltInTemplates()
    await this.recoverExpiredRuns()
    this.initialized = true
  }

  close(): void { this.db?.close(); this.db = undefined; this.initialized = false; this.initializing = undefined }

  async loadGraph(graphId = 'main'): Promise<WorkflowGraph> {
    await this.init()
    const row = this.requireDb().prepare('SELECT graph_json, revision FROM graphs WHERE id = ?').get(graphId) as DbRow | undefined
    if (!row) throw new Error(`Graph not found: ${graphId}`)
    return normalizeGraph(parseJson(row.graph_json), Number(row.revision))
  }

  async saveGraph(graph: WorkflowGraph, expectedRevision = graph.revision, transactionId = `full-${nanoid(10)}`): Promise<WorkflowGraph> {
    await this.init()
    return this.transaction(() => {
      const db = this.requireDb()
      const row = db.prepare('SELECT revision FROM graphs WHERE id = ?').get(graph.id) as DbRow | undefined
      if (!row) throw new Error(`Graph not found: ${graph.id}`)
      const current = Number(row.revision)
      if (current !== expectedRevision) throw new RevisionConflictError(current, expectedRevision)
      const next = normalizeGraph({ ...graph, schemaVersion: '2.0', updatedAt: nowIso() }, current + 1)
      const changed = db.prepare('UPDATE graphs SET revision = ?, graph_json = ?, updated_at = ? WHERE id = ? AND revision = ?')
        .run(next.revision, JSON.stringify(next), next.updatedAt, next.id, current).changes
      if (!changed) throw new RevisionConflictError(current, expectedRevision)
      db.prepare('INSERT INTO graph_revisions(graph_id, revision, graph_json, transaction_id, created_at) VALUES(?,?,?,?,?)')
        .run(next.id, next.revision, JSON.stringify(next), transactionId, next.updatedAt)
      return next
    })
  }

  async applyPatch(patch: GraphPatch, graphId = 'main'): Promise<WorkflowGraph> {
    await this.init()
    return this.transaction(() => {
      const db = this.requireDb()
      const row = db.prepare('SELECT graph_json, revision FROM graphs WHERE id = ?').get(graphId) as DbRow | undefined
      if (!row) throw new Error(`Graph not found: ${graphId}`)
      const current = normalizeGraph(parseJson(row.graph_json), Number(row.revision))
      const patched = applyGraphPatch(current, patch)
      const next = normalizeGraph(patched, current.revision + 1)
      const changed = db.prepare('UPDATE graphs SET revision = ?, graph_json = ?, updated_at = ? WHERE id = ? AND revision = ?')
        .run(next.revision, JSON.stringify(next), next.updatedAt, graphId, current.revision).changes
      if (!changed) throw new RevisionConflictError(current.revision, patch.baseRevision)
      db.prepare('INSERT INTO graph_revisions(graph_id, revision, graph_json, transaction_id, created_at) VALUES(?,?,?,?,?)')
        .run(graphId, next.revision, JSON.stringify(next), patch.transactionId, next.updatedAt)
      return next
    })
  }

  async listGraphRevisions(graphId = 'main', limit = 50): Promise<Array<{ revision: number; transactionId?: string; createdAt: string }>> {
    await this.init()
    return (this.requireDb().prepare('SELECT revision, transaction_id, created_at FROM graph_revisions WHERE graph_id = ? ORDER BY revision DESC LIMIT ?')
      .all(graphId, limit) as DbRow[]).map((row) => ({ revision: Number(row.revision), transactionId: asOptionalString(row.transaction_id), createdAt: String(row.created_at) }))
  }

  async restoreGraphRevision(revision: number, graphId = 'main'): Promise<WorkflowGraph> {
    await this.init()
    const row = this.requireDb().prepare('SELECT graph_json FROM graph_revisions WHERE graph_id = ? AND revision = ?').get(graphId, revision) as DbRow | undefined
    if (!row) throw new Error(`Graph revision not found: ${graphId}@${revision}`)
    const current = await this.loadGraph(graphId)
    const old = normalizeGraph(parseJson(row.graph_json), current.revision)
    return this.saveGraph(old, current.revision, `restore-${revision}-${nanoid(6)}`)
  }

  async loadSelection(): Promise<SelectionState> {
    await this.init()
    const row = this.requireDb().prepare('SELECT selection_json FROM selection WHERE id = 1').get() as DbRow | undefined
    return row ? parseJson(row.selection_json) as SelectionState : { selectedNodeIds: [], selectedEdgeIds: [], updatedAt: nowIso() }
  }

  async saveSelection(selection: Omit<SelectionState, 'updatedAt'> | SelectionState): Promise<SelectionState> {
    await this.init()
    const next: SelectionState = { selectedNodeIds: selection.selectedNodeIds, selectedEdgeIds: selection.selectedEdgeIds, updatedAt: nowIso() }
    this.requireDb().prepare(`INSERT INTO selection(id, selection_json, updated_at) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET selection_json=excluded.selection_json, updated_at=excluded.updated_at`).run(JSON.stringify(next), next.updatedAt)
    return next
  }

  async listArtifacts(options: { limit?: number; status?: ArtifactStatus; runId?: string } = {}): Promise<ArtifactRef[]> {
    await this.init()
    const clauses: string[] = []
    const values: Array<string | number | null> = []
    if (options.status) { clauses.push('status = ?'); values.push(options.status) }
    if (options.runId) { clauses.push('run_id = ?'); values.push(options.runId) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5000))
    const rows = this.requireDb().prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at ASC LIMIT ?`).all(...values, limit) as DbRow[]
    return rows.map(rowToArtifact)
  }

  async getArtifact(id: string): Promise<ArtifactRef | undefined> {
    await this.init()
    const row = this.requireDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as DbRow | undefined
    return row ? rowToArtifact(row) : undefined
  }

  async registerArtifact(input: {
    filePath: string
    kind?: ArtifactRef['kind']
    status?: ArtifactStatus
    parentArtifactIds?: string[]
    runId?: string
    nodeId?: string
    metadata?: Record<string, unknown>
    copyIntoStore?: boolean
  }): Promise<ArtifactRef> {
    await this.init()
    const sourcePath = path.resolve(input.filePath)
    const fileStat = await stat(sourcePath)
    if (!fileStat.isFile()) throw new Error(`Artifact source is not a file: ${sourcePath}`)
    const id = `artifact-${nanoid(12)}`
    const fileName = sanitizeFileName(path.basename(sourcePath))
    const targetDir = path.join(this.artifactsDir, id)
    await ensureDir(targetDir)
    const storedPath = input.copyIntoStore === false ? sourcePath : path.join(targetDir, fileName)
    if (input.copyIntoStore !== false) await copyFile(sourcePath, storedPath)
    const storedBuffer = await readFile(storedPath)
    const metadata = await readArtifactMetadata(storedPath, input.kind ?? 'image')
    const now = nowIso()
    const artifact: ArtifactRef = {
      id, kind: input.kind ?? 'image', status: input.status ?? 'candidate', filePath: storedPath,
      url: `/api/artifacts/${id}/file`, mimeType: metadata.mimeType, fileName, sha256: sha256(storedBuffer),
      sizeBytes: storedBuffer.length, width: metadata.width, height: metadata.height,
      parentArtifactIds: input.parentArtifactIds ?? [], runId: input.runId, nodeId: input.nodeId,
      metadata: input.metadata ?? {}, createdAt: now, updatedAt: now
    }
    try {
      this.requireDb().prepare(`INSERT INTO artifacts(
        id,kind,status,file_path,url,mime_type,file_name,sha256,size_bytes,width,height,parent_ids_json,run_id,node_id,metadata_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        artifact.id, artifact.kind, artifact.status, artifact.filePath, artifact.url, artifact.mimeType, artifact.fileName,
        artifact.sha256, artifact.sizeBytes, artifact.width ?? null, artifact.height ?? null, JSON.stringify(artifact.parentArtifactIds),
        artifact.runId ?? null, artifact.nodeId ?? null, JSON.stringify(artifact.metadata ?? {}), artifact.createdAt, artifact.updatedAt
      )
      return artifact
    } catch (error) {
      if (input.copyIntoStore !== false) await rm(targetDir, { recursive: true, force: true })
      throw error
    }
  }

  async updateArtifactStatus(id: string, status: ArtifactStatus, metadataPatch: Record<string, unknown> = {}): Promise<ArtifactRef> {
    await this.init()
    return this.transaction(() => {
      const row = this.requireDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as DbRow | undefined
      if (!row) throw new Error(`Artifact not found: ${id}`)
      const artifact = rowToArtifact(row)
      artifact.status = status
      artifact.metadata = { ...(artifact.metadata ?? {}), ...metadataPatch }
      artifact.updatedAt = nowIso()
      this.requireDb().prepare('UPDATE artifacts SET status=?, metadata_json=?, updated_at=? WHERE id=?')
        .run(status, JSON.stringify(artifact.metadata), artifact.updatedAt, id)
      return artifact
    })
  }

  async artifactLineage(id: string): Promise<ArtifactLineage> {
    await this.init()
    const db = this.requireDb()
    const artifactRow = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as DbRow | undefined
    if (!artifactRow) throw new Error(`Artifact not found: ${id}`)
    const artifact = rowToArtifact(artifactRow)

    // Recursive CTE walks the parent_ids_json edge list in SQL instead of loading the full table.
    const ancestorRows = db.prepare(`
      WITH RECURSIVE lineage(current_id) AS (
        SELECT je.value FROM artifacts a, json_each(a.parent_ids_json) AS je WHERE a.id = ?
        UNION
        SELECT je.value FROM lineage
        JOIN artifacts a ON a.id = lineage.current_id
        JOIN json_each(a.parent_ids_json) AS je
      )
      SELECT DISTINCT a.* FROM lineage JOIN artifacts a ON a.id = lineage.current_id
    `).all(id) as DbRow[]
    const ancestors = ancestorRows.map(rowToArtifact)

    const descendantRows = db.prepare(`
      WITH RECURSIVE lineage(descendant_id) AS (
        SELECT a.id FROM artifacts a WHERE EXISTS (SELECT 1 FROM json_each(a.parent_ids_json) AS je WHERE je.value = ?)
        UNION
        SELECT child.id FROM lineage
        JOIN artifacts child ON EXISTS (
          SELECT 1 FROM json_each(child.parent_ids_json) AS je WHERE je.value = lineage.descendant_id
        )
      )
      SELECT DISTINCT a.* FROM lineage JOIN artifacts a ON a.id = lineage.descendant_id
    `).all(id) as DbRow[]
    const descendants = descendantRows.map(rowToArtifact)

    return { artifact, ancestors, descendants }
  }

  async saveUploadedFile(buffer: Buffer, originalName: string): Promise<string> {
    await this.init()
    const fileName = `${Date.now()}-${nanoid(6)}-${sanitizeFileName(originalName, 'upload.png')}`
    const filePath = path.join(this.uploadsDir, fileName)
    await writeFile(filePath, buffer)
    return filePath
  }

  async enqueueRun(graph: WorkflowGraph, targetNodeId?: string, maxAttempts = 2, options: { status?: 'queued' | 'running'; workerId?: string } = {}): Promise<WorkflowRun> {
    await this.init()
    if (targetNodeId && !graph.nodes.some((node) => node.id === targetNodeId)) throw new Error(`Target node not found: ${targetNodeId}`)
    const now = nowIso()
    const status = options.status ?? 'queued'
    const run: WorkflowRun = {
      id: `run-${Date.now()}-${nanoid(8)}`, graphId: graph.id, graphRevision: graph.revision,
      graphSnapshot: structuredClone(graph), status, targetNodeId, queuedAt: now,
      startedAt: status === 'running' ? now : undefined,
      nodeRuns: {}, attempts: status === 'running' ? 1 : 0, maxAttempts, estimatedCostUsd: 0, actualCostUsd: 0,
      workerId: status === 'running' ? options.workerId : undefined,
      createdAt: now, updatedAt: now
    }
    this.insertRun(run)
    return run
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    await this.init()
    this.transaction(() => {
      const db = this.requireDb()
      const row = db.prepare('SELECT status, worker_id FROM runs WHERE id = ?').get(run.id) as DbRow | undefined
      if (!row) throw new Error(`Run not found: ${run.id}`)
      const currentStatus = String(row.status)
      const currentWorker = asOptionalString(row.worker_id)
      if (currentStatus === 'cancelled' && run.status !== 'cancelled') throw new RunStateConflictError(`Run ${run.id} was cancelled by another process.`)
      if (['completed', 'failed'].includes(currentStatus) && run.status !== currentStatus) throw new RunStateConflictError(`Run ${run.id} is already ${currentStatus}.`)
      if (currentWorker && run.workerId && currentWorker !== run.workerId) throw new RunStateConflictError(`Run ${run.id} is owned by worker ${currentWorker}, not ${run.workerId}.`)
      if (currentStatus === 'queued' && run.status === 'running' && currentWorker && currentWorker !== run.workerId) throw new RunStateConflictError(`Queued run ${run.id} cannot be resumed by ${run.workerId || 'an unknown worker'}.`)
      run.updatedAt = nowIso()
      db.prepare(`UPDATE runs SET status=?, queued_at=?, started_at=?, completed_at=?, attempts=?, max_attempts=?, estimated_cost=?, actual_cost=?,
        worker_id=?, lock_expires_at=?, run_json=?, updated_at=? WHERE id=?`).run(
        run.status, run.queuedAt, run.startedAt ?? null, run.completedAt ?? null, run.attempts, run.maxAttempts, run.estimatedCostUsd, run.actualCostUsd,
        run.workerId ?? null, run.lockExpiresAt ?? null, JSON.stringify(run), run.updatedAt, run.id
      )
      const snapshotSeq = Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_snapshots WHERE run_id = ?').get(run.id) as DbRow).max_seq) + 1
      db.prepare('INSERT INTO run_snapshots(run_id, seq, status, run_json, created_at) VALUES(?,?,?,?,?)')
        .run(run.id, snapshotSeq, run.status, JSON.stringify(run), run.updatedAt)
    })
  }

  async loadRun(id: string): Promise<WorkflowRun | undefined> {
    await this.init()
    const row = this.requireDb().prepare(`SELECT run_json,status,started_at,completed_at,attempts,max_attempts,estimated_cost,actual_cost,
      worker_id,lock_expires_at,updated_at FROM runs WHERE id = ?`).get(id) as DbRow | undefined
    if (!row) return undefined
    const run = parseJson(row.run_json) as WorkflowRun
    run.status = String(row.status) as WorkflowRun['status']
    run.startedAt = asOptionalString(row.started_at)
    run.completedAt = asOptionalString(row.completed_at)
    run.attempts = Number(row.attempts)
    run.maxAttempts = Number(row.max_attempts)
    run.estimatedCostUsd = Number(row.estimated_cost)
    run.actualCostUsd = Number(row.actual_cost)
    run.workerId = asOptionalString(row.worker_id)
    run.lockExpiresAt = asOptionalString(row.lock_expires_at)
    run.updatedAt = String(row.updated_at)
    return run
  }

  async listRuns(limit = 100): Promise<WorkflowRun[]> {
    await this.init()
    return (this.requireDb().prepare('SELECT run_json FROM runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 1000))) as DbRow[])
      .map((row) => parseJson(row.run_json) as WorkflowRun)
  }

  async claimNextRun(workerId: string, leaseSeconds: number): Promise<WorkflowRun | undefined> {
    await this.init()
    return this.transaction(() => {
      const db = this.requireDb()
      const row = db.prepare("SELECT id, run_json FROM runs WHERE status='queued' ORDER BY queued_at ASC LIMIT 1").get() as DbRow | undefined
      if (!row) return undefined
      const run = parseJson(row.run_json) as WorkflowRun
      const now = nowIso()
      run.status = 'running'; run.startedAt ||= now; run.attempts += 1; run.workerId = workerId
      run.lockExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString(); run.updatedAt = now
      const changed = db.prepare("UPDATE runs SET status='running', started_at=?, attempts=?, worker_id=?, lock_expires_at=?, run_json=?, updated_at=? WHERE id=? AND status='queued'")
        .run(run.startedAt, run.attempts, workerId, run.lockExpiresAt, JSON.stringify(run), now, run.id).changes
      return changed ? run : undefined
    })
  }

  async heartbeatRun(runId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    await this.init()
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString()
    const changed = this.requireDb().prepare("UPDATE runs SET lock_expires_at=?, updated_at=? WHERE id=? AND status='running' AND worker_id=?")
      .run(expiresAt, nowIso(), runId, workerId).changes
    return changed > 0
  }

  async cancelRun(runId: string): Promise<boolean> {
    await this.init()
    return this.transaction(() => {
      const db = this.requireDb()
      const row = db.prepare('SELECT status,run_json FROM runs WHERE id=?').get(runId) as DbRow | undefined
      if (!row || ['completed', 'failed', 'cancelled'].includes(String(row.status))) return false
      const run = parseJson(row.run_json) as WorkflowRun
      const completedAt = nowIso()
      run.status = 'cancelled'; run.completedAt = completedAt; run.error = 'Cancelled by user.'
      run.workerId = undefined; run.lockExpiresAt = undefined; run.updatedAt = completedAt
      const changed = db.prepare("UPDATE runs SET status='cancelled',completed_at=?,worker_id=NULL,lock_expires_at=NULL,run_json=?,updated_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled')")
        .run(completedAt, JSON.stringify(run), completedAt, runId).changes
      return changed > 0
    })
  }

  async resolveRunSelection(runId: string, nodeId: string, artifactId: string): Promise<WorkflowRun> {
    await this.init()
    const run = await this.loadRun(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    const node = run.graphSnapshot.nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error(`Run node not found: ${nodeId}`)
    node.data.config = { ...node.data.config, selectedArtifactId: artifactId }
    run.status = 'queued'; run.completedAt = undefined; run.error = undefined; run.workerId = undefined; run.lockExpiresAt = undefined
    delete run.nodeRuns[nodeId]
    run.queuedAt = nowIso()
    await this.saveRun(run)
    return run
  }

  async recoverExpiredRuns(): Promise<number> {
    // Do NOT call this.init() here — recoverExpiredRuns is invoked from within initialize(),
    // so init() would re-await the in-flight initialization promise and deadlock. Every other
    // public method calls init(); this one is called only after the DB is guaranteed open.
    if (!this.db) return 0
    return this.transaction(() => {
      const db = this.requireDb()
      const rows = db.prepare("SELECT run_json FROM runs WHERE status='running' AND (lock_expires_at IS NULL OR lock_expires_at < ?)").all(nowIso()) as DbRow[]
      let count = 0
      for (const row of rows) {
        const run = parseJson(row.run_json) as WorkflowRun
        run.workerId = undefined; run.lockExpiresAt = undefined; run.updatedAt = nowIso()
        if (run.attempts < run.maxAttempts) { run.status = 'queued'; run.queuedAt = nowIso(); run.error = 'Recovered after an expired worker lease.' }
        else { run.status = 'failed'; run.completedAt = nowIso(); run.error = 'Run failed after worker crash recovery exhausted retries.' }
        db.prepare("UPDATE runs SET status=?, queued_at=?, completed_at=?, worker_id=NULL, lock_expires_at=NULL, run_json=?, updated_at=? WHERE id=? AND status='running'")
          .run(run.status, run.queuedAt, run.completedAt ?? null, JSON.stringify(run), run.updatedAt, run.id)
        count += 1
      }
      return count
    })
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    await this.init()
    this.requireDb().prepare('INSERT INTO run_events(run_id,event_json,created_at) VALUES(?,?,?)')
      .run(event.runId ?? null, JSON.stringify(event), event.timestamp)
  }

  async listRunEvents(runId: string, afterSeq = 0, limit = 500): Promise<Array<{ seq: number; event: RunEvent }>> {
    await this.init()
    return (this.requireDb().prepare('SELECT seq,event_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(runId, afterSeq, limit) as DbRow[]).map((row) => ({ seq: Number(row.seq), event: parseJson(row.event_json) as RunEvent }))
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    await this.init()
    const row = this.requireDb().prepare('SELECT value_json FROM cache WHERE cache_key = ?').get(key) as DbRow | undefined
    return row ? parseJson(row.value_json) as T : undefined
  }

  async setCache(key: string, value: unknown): Promise<void> {
    await this.init()
    this.requireDb().prepare(`INSERT INTO cache(cache_key,value_json,created_at) VALUES(?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json, created_at=excluded.created_at`).run(key, JSON.stringify(value), nowIso())
  }

  async listTemplates(): Promise<TemplateRecord[]> {
    await this.init()
    return (this.requireDb().prepare('SELECT * FROM templates ORDER BY built_in DESC, name ASC').all() as DbRow[]).map(rowToTemplate)
  }

  async saveTemplate(input: Omit<TemplateRecord, 'createdAt' | 'updatedAt'>): Promise<TemplateRecord> {
    await this.init()
    const now = nowIso()
    const template: TemplateRecord = { ...input, createdAt: now, updatedAt: now }
    this.requireDb().prepare(`INSERT INTO templates(id,name,description,category,graph_json,built_in,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,graph_json=excluded.graph_json,updated_at=excluded.updated_at`)
      .run(template.id, template.name, template.description, template.category, JSON.stringify(template.graph), template.builtIn ? 1 : 0, now, now)
    return template
  }

  async applyTemplate(templateId: string): Promise<WorkflowGraph> {
    await this.init()
    const row = this.requireDb().prepare('SELECT * FROM templates WHERE id = ?').get(templateId) as DbRow | undefined
    if (!row) throw new Error(`Template not found: ${templateId}`)
    const template = rowToTemplate(row)
    const current = await this.loadGraph()
    const graph = structuredClone(template.graph)
    graph.id = current.id; graph.revision = current.revision; graph.createdAt = current.createdAt; graph.updatedAt = nowIso()
    return this.saveGraph(graph, current.revision, `template-${templateId}-${nanoid(6)}`)
  }


  async databaseDiagnostics(): Promise<{ journalMode: string; userVersion: number; foreignKeys: boolean }> {
    await this.init()
    const db = this.requireDb()
    const journal = db.prepare('PRAGMA journal_mode').get() as DbRow
    const version = db.prepare('PRAGMA user_version').get() as DbRow
    const foreign = db.prepare('PRAGMA foreign_keys').get() as DbRow
    return {
      journalMode: String(journal.journal_mode || ''),
      userVersion: Number(version.user_version || 0),
      foreignKeys: Number(foreign.foreign_keys || 0) === 1
    }
  }

  async context(): Promise<WorkspaceContext> {
    const [graph, selection, database] = await Promise.all([this.loadGraph(), this.loadSelection(), this.databaseDiagnostics()])
    return {
      projectDir: this.projectDir, dataDir: this.dataDir, databaseFile: this.databaseFile,
      artifactsDir: this.artifactsDir, runsDir: this.runsDir, database,
      graph: { id: graph.id, revision: graph.revision, name: graph.name, mode: graph.mode, nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      selection
    }
  }

  private requireDb(): DatabaseSyncType { if (!this.db) throw new Error('WorkspaceStorage is not initialized.'); return this.db }

  private transaction<T>(work: () => T extends Promise<unknown> ? never : T): T {
    const db = this.requireDb(); db.exec('BEGIN IMMEDIATE')
    try { const value = work(); db.exec('COMMIT'); return value } catch (error) { try { db.exec('ROLLBACK') } catch { /* ignore */ }; throw error }
  }

  private insertRun(run: WorkflowRun): void {
    this.requireDb().prepare(`INSERT INTO runs(id,graph_id,graph_revision,target_node_id,status,queued_at,started_at,completed_at,attempts,max_attempts,
      estimated_cost,actual_cost,worker_id,lock_expires_at,run_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.id, run.graphId, run.graphRevision, run.targetNodeId ?? null, run.status, run.queuedAt, run.startedAt ?? null, run.completedAt ?? null,
      run.attempts, run.maxAttempts, run.estimatedCostUsd, run.actualCostUsd, run.workerId ?? null, run.lockExpiresAt ?? null,
      JSON.stringify(run), run.createdAt, run.updatedAt
    )
  }

  private async migrateLegacyFiles(): Promise<void> {
    const db = this.requireDb()
    const graphCount = Number((db.prepare('SELECT COUNT(*) AS count FROM graphs').get() as DbRow).count)
    if (!graphCount) {
      let graph = createStarterGraph()
      try { graph = normalizeGraph(await readJsonFile<WorkflowGraph>(this.graphFile, graph), 0) } catch { /* starter */ }
      graph = normalizeGraph(graph, 0)
      db.prepare('INSERT OR IGNORE INTO graphs(id,revision,graph_json,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(graph.id, graph.revision, JSON.stringify(graph), graph.createdAt, graph.updatedAt)
      db.prepare('INSERT OR IGNORE INTO graph_revisions(graph_id,revision,graph_json,transaction_id,created_at) VALUES(?,?,?,?,?)')
        .run(graph.id, graph.revision, JSON.stringify(graph), 'migration-or-initial', graph.updatedAt)
    }
    const selectionCount = Number((db.prepare('SELECT COUNT(*) AS count FROM selection').get() as DbRow).count)
    if (!selectionCount) {
      const selection = await readJsonFile<SelectionState>(this.selectionFile, { selectedNodeIds: [], selectedEdgeIds: [], updatedAt: nowIso() })
      db.prepare('INSERT OR IGNORE INTO selection(id,selection_json,updated_at) VALUES(1,?,?)').run(JSON.stringify(selection), selection.updatedAt)
    }
    const artifactCount = Number((db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as DbRow).count)
    if (!artifactCount) {
      const legacy = await readJsonFile<Array<Partial<ArtifactRef>>>(this.artifactsFile, [])
      for (const item of legacy) {
        if (!item.id || !item.filePath) continue
        const now = item.createdAt || nowIso()
        db.prepare(`INSERT OR IGNORE INTO artifacts(id,kind,status,file_path,url,mime_type,file_name,sha256,size_bytes,width,height,parent_ids_json,run_id,node_id,metadata_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          item.id, item.kind || 'image', item.status || 'candidate', item.filePath, item.url || `/api/artifacts/${item.id}/file`, item.mimeType || 'application/octet-stream',
          item.fileName || path.basename(item.filePath), item.sha256 || '', item.sizeBytes || 0, item.width ?? null, item.height ?? null,
          JSON.stringify(item.parentArtifactIds || []), item.runId ?? null, item.nodeId ?? null, JSON.stringify(item.metadata || {}), now, item.updatedAt || now
        )
      }
    }
  }

  private seedBuiltInTemplates(): void {
    const db = this.requireDb()
    for (const template of createBuiltInTemplates()) {
      db.prepare(`INSERT OR IGNORE INTO templates(id,name,description,category,graph_json,built_in,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(template.id, template.name, template.description, template.category, JSON.stringify(template.graph), 1, template.createdAt, template.updatedAt)
    }
  }
}

type DbValue = string | number | bigint | null | Uint8Array
type DbRow = Record<string, DbValue>

function parseJson(value: DbValue): unknown { return JSON.parse(String(value)) }
function asOptionalString(value: DbValue | undefined): string | undefined { return value === null || value === undefined ? undefined : String(value) }

function normalizeGraph(input: unknown, revision: number): WorkflowGraph {
  const value = input as Partial<WorkflowGraph>
  return workflowGraphSchema.parse({ ...value, schemaVersion: '2.0', revision }) as WorkflowGraph
}

function rowToArtifact(row: DbRow): ArtifactRef {
  return {
    id: String(row.id), kind: String(row.kind) as ArtifactRef['kind'], status: String(row.status) as ArtifactStatus,
    filePath: String(row.file_path), url: String(row.url), mimeType: String(row.mime_type), fileName: String(row.file_name),
    sha256: String(row.sha256), sizeBytes: Number(row.size_bytes), width: row.width === null ? undefined : Number(row.width),
    height: row.height === null ? undefined : Number(row.height), parentArtifactIds: parseJson(row.parent_ids_json) as string[],
    runId: asOptionalString(row.run_id), nodeId: asOptionalString(row.node_id), metadata: parseJson(row.metadata_json) as Record<string, unknown>,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  }
}

function rowToTemplate(row: DbRow): TemplateRecord {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description), category: String(row.category),
    graph: parseJson(row.graph_json) as WorkflowGraph, builtIn: Number(row.built_in) === 1,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  }
}

async function readArtifactMetadata(filePath: string, kind: ArtifactRef['kind']): Promise<{ mimeType: string; width?: number; height?: number }> {
  if (!['image', 'mask', 'annotation'].includes(kind)) {
    const ext = path.extname(filePath).toLowerCase()
    return { mimeType: ext === '.json' ? 'application/json' : 'text/plain' }
  }
  try {
    const metadata = await sharp(filePath).metadata()
    return { mimeType: mimeForFormat(metadata.format), width: metadata.width, height: metadata.height }
  } catch {
    return { mimeType: 'application/octet-stream' }
  }
}

function mimeForFormat(format?: string): string {
  switch (format) {
    case 'png': return 'image/png'
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'avif': return 'image/avif'
    default: return 'application/octet-stream'
  }
}
