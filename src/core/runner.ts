import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { nanoid } from 'nanoid'
import type {
  ArtifactRef, CanvasNode, EvaluationReport, NodeRunRecord, PromptSpec, RunEvent,
  WorkflowGraph, WorkflowRun
} from './types.js'
import type { RuntimeConfig } from './config.js'
import { executionNodeIds, topologicalSort, validateGraph } from './graph.js'
import { getNodeDefinition } from './node-registry.js'
import { Image2Provider } from './image-provider.js'
import { createLLMProvider, type LLMProvider } from './llm-provider.js'
import { evaluationReportSchema, promptSpecSchema } from './schemas.js'
import { WorkspaceStorage } from './storage.js'
import { nowIso, sha256, stableStringify, ensureDir } from './utils.js'

interface NodeExecutionResult { outputs: Record<string, unknown>; estimatedCostUsd?: number; actualCostUsd?: number }

export class NeedsInputError extends Error {
  constructor(message: string, readonly payload: Record<string, unknown>) { super(message) }
}

export class WorkflowRunner extends EventEmitter {
  private readonly imageProvider: Image2Provider
  private readonly architectLLM: LLMProvider
  private readonly reviewerLLM: LLMProvider
  private readonly activeControllers = new Map<string, AbortController>()

  constructor(private readonly storage: WorkspaceStorage, private readonly config: RuntimeConfig) {
    super()
    this.imageProvider = new Image2Provider(config.image, storage)
    this.architectLLM = createLLMProvider(config.llm.architect)
    this.reviewerLLM = createLLMProvider(config.llm.reviewer)
  }

  async execute(run: WorkflowRun, workerId: string, depth = 0): Promise<WorkflowRun> {
    if (depth > 4) throw new Error('Subworkflow nesting exceeds the maximum depth of 4.')
    const controller = new AbortController()
    this.activeControllers.set(run.id, controller)
    const graph = run.graphSnapshot
    try {
      const validation = validateGraph(graph)
      if (!validation.valid) throw new Error(validation.problems.filter((item) => item.severity === 'error').map((item) => item.message).join('；'))
      const requiredIds = executionNodeIds(graph, run.targetNodeId)
      if (!requiredIds.size) throw new Error('No executable workflow nodes were found. Connect nodes to an output or run to a specific node.')
      const order = topologicalSort(graph.nodes, graph.edges).filter((id) => requiredIds.has(id))
      const wasQueued = run.status === 'queued'
      run.status = 'running'; run.workerId = workerId; run.startedAt ||= nowIso(); run.updatedAt = nowIso()
      if (wasQueued) run.attempts += 1
      await this.storage.saveRun(run)
      this.emitEvent({ type: 'run-started', runId: run.id, message: `Run started at graph revision ${run.graphRevision}.`, timestamp: nowIso() })

      const outputs = new Map<string, Record<string, unknown>>()
      for (const [nodeId, record] of Object.entries(run.nodeRuns)) {
        if (['completed', 'cached'].includes(record.status) && record.outputs) outputs.set(nodeId, record.outputs)
      }

      for (const nodeId of order) {
        await this.checkCancellation(run, controller)
        const prior = run.nodeRuns[nodeId]
        if (prior && ['completed', 'cached'].includes(prior.status) && prior.outputs) continue
        const node = graph.nodes.find((item) => item.id === nodeId)
        if (!node) throw new Error(`Run snapshot is missing node: ${nodeId}`)
        const inputs = await this.resolveInputs(graph, node, outputs)
        const cacheKey = await this.cacheKey(node, inputs)
        const cached = shouldCache(node) ? await this.storage.getCache<Record<string, unknown>>(cacheKey) : undefined
        if (cached) {
          const record: NodeRunRecord = { nodeId, nodeType: node.data.nodeType, status: 'cached', cacheKey, outputs: cached, startedAt: nowIso(), completedAt: nowIso(), durationMs: 0 }
          run.nodeRuns[nodeId] = record; outputs.set(nodeId, cached); await this.storage.saveRun(run)
          this.emitEvent({ type: 'node-completed', runId: run.id, nodeId, message: `${node.data.nodeType} reused cached output.`, payload: record, timestamp: nowIso() })
          continue
        }

        const startedAt = nowIso(); const startedMs = Date.now()
        run.nodeRuns[nodeId] = { nodeId, nodeType: node.data.nodeType, status: 'running', startedAt, cacheKey, attempt: run.attempts }
        await this.storage.saveRun(run)
        this.emitEvent({ type: 'node-started', runId: run.id, nodeId, message: `${node.data.nodeType} started.`, timestamp: startedAt })
        try {
          const result = await this.executeNode(graph, node, inputs, run, controller.signal, workerId, depth)
          await this.checkCancellation(run, controller)
          const completedAt = nowIso()
          const record: NodeRunRecord = {
            nodeId, nodeType: node.data.nodeType, status: 'completed', startedAt, completedAt, cacheKey,
            outputs: result.outputs, durationMs: Date.now() - startedMs, estimatedCostUsd: result.estimatedCostUsd, actualCostUsd: result.actualCostUsd, attempt: run.attempts
          }
          run.nodeRuns[nodeId] = record; outputs.set(nodeId, result.outputs)
          run.estimatedCostUsd = roundMoney(run.estimatedCostUsd + Number(result.estimatedCostUsd || 0))
          run.actualCostUsd = roundMoney(run.actualCostUsd + Number(result.actualCostUsd || 0))
          if (shouldCache(node)) await this.storage.setCache(cacheKey, result.outputs)
          await this.storage.saveRun(run)
          this.emitEvent({ type: 'node-completed', runId: run.id, nodeId, message: `${node.data.nodeType} completed.`, payload: record, timestamp: completedAt })
        } catch (error) {
          if (error instanceof NeedsInputError) {
            const completedAt = nowIso()
            run.nodeRuns[nodeId] = { nodeId, nodeType: node.data.nodeType, status: 'needs-input', startedAt, completedAt, outputs: error.payload, error: error.message, durationMs: Date.now() - startedMs }
            run.status = 'needs-input'; run.error = error.message; run.workerId = undefined; run.lockExpiresAt = undefined; run.updatedAt = completedAt
            await this.storage.saveRun(run)
            this.emitEvent({ type: 'node-needs-input', runId: run.id, nodeId, message: error.message, payload: error.payload, timestamp: completedAt })
            return run
          }
          throw error
        }
      }

      run.status = 'completed'; run.completedAt = nowIso(); run.workerId = undefined; run.lockExpiresAt = undefined; run.error = undefined
      await this.storage.saveRun(run)
      this.emitEvent({ type: 'run-completed', runId: run.id, message: 'Workflow run completed.', payload: { estimatedCostUsd: run.estimatedCostUsd, actualCostUsd: run.actualCostUsd }, timestamp: run.completedAt })
      return run
    } catch (error) {
      const latest = await this.storage.loadRun(run.id)
      const cancelled = controller.signal.aborted || latest?.status === 'cancelled' || error instanceof DOMException && error.name === 'AbortError'
      run.status = cancelled ? 'cancelled' : 'failed'; run.completedAt = nowIso(); run.workerId = undefined; run.lockExpiresAt = undefined
      run.error = cancelled ? 'Run cancelled.' : error instanceof Error ? error.message : String(error)
      const activeNode = Object.values(run.nodeRuns).find((item) => item.status === 'running')
      if (activeNode) { activeNode.status = cancelled ? 'cancelled' : 'failed'; activeNode.completedAt = run.completedAt; activeNode.error = run.error }
      await this.storage.saveRun(run)
      this.emitEvent({ type: cancelled ? 'run-cancelled' : 'run-failed', runId: run.id, nodeId: activeNode?.nodeId, message: run.error, timestamp: run.completedAt })
      return run
    } finally {
      this.activeControllers.delete(run.id)
    }
  }

  async cancel(runId: string): Promise<boolean> {
    // Abort the in-flight execution (fetch, sleep, etc.) via the AbortController.
    // Do NOT call openCode.abortSession(undefined) — it targets the shared global
    // session and would disrupt unrelated concurrent runs. The AbortController is
    // already threaded into every fetch this run performs.
    this.activeControllers.get(runId)?.abort('Cancelled by user.')
    // Propagate cancellation to subflow child runs so they stop burning API budget.
    await this.cancelSubflowChildren(runId)
    return this.storage.cancelRun(runId)
  }

  private async cancelSubflowChildren(runId: string): Promise<void> {
    const run = await this.storage.loadRun(runId).catch(() => undefined)
    if (!run) return
    const childIds = Object.values(run.nodeRuns)
      .filter((record) => record.nodeType === 'workflow.subflow' && record.outputs)
      .map((record) => (record.outputs as { metadata?: { childRunId?: string } }).metadata?.childRunId)
      .filter((childId): childId is string => Boolean(childId))
    await Promise.all(childIds.map((childId) => this.cancel(childId)))
  }

  capabilities() { return this.imageProvider.capabilities() }

  private async checkCancellation(run: WorkflowRun, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) throw new DOMException('Run cancelled.', 'AbortError')
    const latest = await this.storage.loadRun(run.id)
    if (latest?.status === 'cancelled') { controller.abort('Cancelled by another process.'); throw new DOMException('Run cancelled.', 'AbortError') }
  }

  private async resolveInputs(graph: WorkflowGraph, node: CanvasNode, outputs: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}
    const definition = getNodeDefinition(node.data.nodeType)
    for (const input of definition?.inputs ?? []) {
      const edges = graph.edges.filter((edge) => edge.target === node.id && edge.targetHandle === input.id)
      const values = edges.map((edge) => outputs.get(edge.source)?.[edge.sourceHandle]).filter((value) => value !== undefined)
      if (input.multiple) result[input.id] = values.flatMap(flattenValue)
      else if (values.length) result[input.id] = values[0]
    }
    return result
  }

  private async executeNode(graph: WorkflowGraph, node: CanvasNode, inputs: Record<string, unknown>, run: WorkflowRun, signal: AbortSignal, workerId: string, depth: number): Promise<NodeExecutionResult> {
    const config = node.data.config
    switch (node.data.nodeType) {
      case 'input.brief': case 'input.prompt': case 'canvas.note': return { outputs: { text: asString(config.text) } }
      case 'input.image': case 'canvas.image': return this.executeImageInput(config)
      case 'input.mask': return this.executeMaskInput(config)
      case 'input.annotation': case 'canvas.annotation': return this.executeAnnotationInput(config)
      case 'utility.aspect-ratio': return { outputs: { ratio: normalizeRatio(config.width, config.height) } }
      case 'agent.prompt-architect': return this.executePromptArchitect(inputs, config, signal)
      case 'image.generate': return this.executeImageGenerate(inputs, config, run, node, signal)
      case 'image.edit': return this.executeImageEdit(inputs, config, run, node, signal)
      case 'image.resize': return this.executeImageResize(inputs, config, run, node, signal)
      case 'control.human-select': return this.executeHumanSelect(inputs, config, run)
      case 'review.quality': return this.executeQualityReview(inputs, config, signal)
      case 'workflow.subflow': return this.executeSubflow(config, inputs, run, workerId, depth)
      case 'output.canvas': return this.executeOutputCanvas(inputs, config, run, graph, node)
      default: throw new Error(`No executor registered for node type: ${node.data.nodeType}`)
    }
  }

  private async executeImageInput(config: Record<string, unknown>): Promise<NodeExecutionResult> {
    const artifactId = asString(config.artifactId)
    if (!artifactId) throw new Error('请先上传或连接图片。')
    return { outputs: { image: await this.requireArtifact(artifactId) } }
  }

  private async executeMaskInput(config: Record<string, unknown>): Promise<NodeExecutionResult> {
    const artifact = await this.requireArtifact(asString(config.artifactId))
    if (artifact.kind !== 'mask') throw new Error('选择的 Artifact 不是蒙版。')
    return { outputs: { mask: artifact } }
  }

  private async executeAnnotationInput(config: Record<string, unknown>): Promise<NodeExecutionResult> {
    const artifactId = asString(config.artifactId)
    const artifact = artifactId ? await this.requireArtifact(artifactId) : undefined
    return { outputs: { annotation: artifact, text: asString(config.text) } }
  }

  private async executePromptArchitect(inputs: Record<string, unknown>, config: Record<string, unknown>, signal: AbortSignal): Promise<NodeExecutionResult> {
    const brief = asString(inputs.brief)
    if (!brief) throw new Error('Prompt 设计节点缺少创作需求。')
    const references = asArtifacts(inputs.references)
    // Use the LLM provider only when the user opts in and the configured provider
    // is not the deterministic fallback. This keeps a freshly installed instance
    // (default profile = fallback) on the local heuristic without surprising calls.
    if (asBoolean(config.llmEnabled, true) && this.architectLLM.kind !== 'fallback') {
      const response = await this.promptArchitectWithLLM(brief, config, references, signal)
      return { outputs: { promptSpec: response.promptSpec }, actualCostUsd: response.cost }
    }
    return { outputs: { promptSpec: buildPromptSpec(brief, config, references) } }
  }

  private async executeImageGenerate(inputs: Record<string, unknown>, config: Record<string, unknown>, run: WorkflowRun, node: CanvasNode, signal: AbortSignal): Promise<NodeExecutionResult> {
    const prompt = requirePromptSpec(inputs.prompt)
    const ratio = normalizeRatioFromUnknown(inputs.size)
    const quality = asString(config.quality, 'high')
    const response = await this.imageProvider.generate({
      prompt, width: ratio.width, height: ratio.height, quality,
      candidateCount: clamp(asNumber(config.candidateCount, 1), 1, this.imageProvider.capabilities().maxCandidates),
      outputFormat: asString(config.outputFormat, this.config.image.outputFormat), runId: run.id, nodeId: node.id, signal
    })
    return { outputs: { images: response.artifacts, metadata: response.metadata }, estimatedCostUsd: response.estimatedCostUsd }
  }

  private async executeImageEdit(inputs: Record<string, unknown>, config: Record<string, unknown>, run: WorkflowRun, node: CanvasNode, signal: AbortSignal): Promise<NodeExecutionResult> {
    const source = requireArtifact(inputs.source)
    let prompt = requirePromptSpec(inputs.prompt)
    const annotation = asOptionalArtifact(inputs.annotation)
    const annotationInstruction = asString(config.annotationInstruction)
    if (annotationInstruction) prompt = { ...prompt, finalPrompt: `${prompt.finalPrompt}\n\n${annotationInstruction}` }
    const ratio = normalizeRatioFromUnknown(inputs.size, source.width, source.height)
    const quality = asString(config.quality, 'high')
    const response = await this.imageProvider.edit({
      prompt, width: ratio.width, height: ratio.height, quality,
      candidateCount: clamp(asNumber(config.candidateCount, 1), 1, this.imageProvider.capabilities().maxCandidates),
      outputFormat: this.config.image.outputFormat, runId: run.id, nodeId: node.id,
      source, references: asArtifacts(inputs.references), mask: asOptionalArtifact(inputs.mask), annotation, signal
    })
    return { outputs: { images: response.artifacts, metadata: response.metadata }, estimatedCostUsd: response.estimatedCostUsd }
  }

  private async executeImageResize(inputs: Record<string, unknown>, config: Record<string, unknown>, run: WorkflowRun, node: CanvasNode, signal: AbortSignal): Promise<NodeExecutionResult> {
    const image = requireArtifact(inputs.image)
    const ratio = inputs.size ? normalizeRatioFromUnknown(inputs.size) : normalizeRatio(config.width, config.height)
    const fit = asString(config.fit, 'contain') as keyof sharp.FitEnum
    const outputPath = path.join(this.storage.runsDir, run.id, node.id, `resized-${ratio.width}x${ratio.height}.png`)
    await ensureDir(path.dirname(outputPath))
    if (signal.aborted) throw new DOMException('Run cancelled.', 'AbortError')
    await sharp(image.filePath).resize(ratio.width, ratio.height, { fit }).png().toFile(outputPath)
    if (signal.aborted) throw new DOMException('Run cancelled.', 'AbortError')
    const artifact = await this.storage.registerArtifact({ filePath: outputPath, kind: 'image', status: 'candidate', runId: run.id, nodeId: node.id, parentArtifactIds: [image.id], metadata: { operation: 'resize', width: ratio.width, height: ratio.height, fit } })
    return { outputs: { image: artifact } }
  }

  private async executeHumanSelect(inputs: Record<string, unknown>, config: Record<string, unknown>, run: WorkflowRun): Promise<NodeExecutionResult> {
    const images = asArtifacts(inputs.images)
    if (!images.length) throw new Error('候选图片选择器没有候选图片。')
    const selectedId = asString(config.selectedArtifactId)
    if (selectedId) {
      const selected = images.find((item) => item.id === selectedId)
      if (!selected) throw new Error('已选 Artifact 不属于当前候选集。')
      await this.storage.updateArtifactStatus(selected.id, 'selected', { selectedByRunId: run.id, selectedAt: nowIso() })
      return { outputs: { selected } }
    }
    if (images.length === 1 && asBoolean(config.autoSelectSingle, true)) {
      const selected = await this.storage.updateArtifactStatus(images[0].id, 'selected', { selectedByRunId: run.id, selectedAt: nowIso(), autoSelected: true })
      return { outputs: { selected } }
    }
    throw new NeedsInputError('请选择一张候选图片后继续运行。', { candidateArtifactIds: images.map((item) => item.id), candidates: images })
  }

  private async executeQualityReview(inputs: Record<string, unknown>, config: Record<string, unknown>, signal: AbortSignal): Promise<NodeExecutionResult> {
    const images = asArtifacts(inputs.images)
    if (!images.length) throw new Error('质量评审节点没有候选图片。')
    const minimumScore = asNumber(config.minimumScore, 70)
    const mode = asString(config.reviewMode, 'hybrid')
    const technical = await technicalReview(images, minimumScore)
    if (mode === 'technical') return { outputs: { selected: images[technical.selectedIndex], images, report: technical } }
    // LLM semantic review only runs when a non-fallback provider is configured.
    // Otherwise we degrade to technical-only review with a warning, even when the
    // user asked for 'agent' mode, so the workflow keeps producing output instead
    // of hard-failing on an unconfigured LLM profile.
    if (this.reviewerLLM.kind === 'fallback') {
      technical.issues.push({ code: 'llm-unavailable', severity: 'warning', message: '未配置 LLM provider，仅执行技术评审。配置 VIBECANVAS_LLM_REVIEWER_* 启用语义评审。' })
      return { outputs: { selected: images[technical.selectedIndex], images, report: technical } }
    }
    const agent = await this.visionReviewWithLLM(images, asString(inputs.brief), minimumScore, signal)
    const report = mode === 'hybrid' ? combineReviews(technical, agent.report, minimumScore) : agent.report
    return { outputs: { selected: images[report.selectedIndex], images, report }, actualCostUsd: agent.cost }
  }

  private async executeSubflow(config: Record<string, unknown>, inputs: Record<string, unknown>, run: WorkflowRun, workerId: string, depth: number): Promise<NodeExecutionResult> {
    const templateId = asString(config.templateId)
    if (!templateId) throw new Error('子工作流节点缺少 templateId。')
    const template = (await this.storage.listTemplates()).find((item) => item.id === templateId)
    if (!template) throw new Error(`Subworkflow template not found: ${templateId}`)
    const childGraph = structuredClone(template.graph)
    injectSubworkflowInput(childGraph, asString(config.inputNodeId), inputs.input)
    const childWorkerId = `${workerId}:subflow:${run.id}`
    const child = await this.storage.enqueueRun(childGraph, asString(config.outputNodeId) || undefined, 1, { status: 'running', workerId: childWorkerId })
    // Link parent cancellation to the child: when the parent aborts, abort the child too.
    const parentController = this.activeControllers.get(run.id)
    const onParentAbort = () => this.activeControllers.get(child.id)?.abort('Parent run cancelled.')
    parentController?.signal.addEventListener('abort', onParentAbort, { once: true })
    let completed: WorkflowRun
    try { completed = await this.execute(child, childWorkerId, depth + 1) }
    finally { parentController?.signal.removeEventListener('abort', onParentAbort) }
    if (completed.status !== 'completed') throw new Error(`Subworkflow ${templateId} ended with status ${completed.status}: ${completed.error || ''}`)
    const outputNodeId = asString(config.outputNodeId) || Object.keys(completed.nodeRuns).at(-1)
    const output = outputNodeId ? completed.nodeRuns[outputNodeId]?.outputs : undefined
    return { outputs: { output, metadata: { childRunId: completed.id, templateId, status: completed.status } }, estimatedCostUsd: completed.estimatedCostUsd, actualCostUsd: completed.actualCostUsd }
  }

  private async executeOutputCanvas(inputs: Record<string, unknown>, config: Record<string, unknown>, run: WorkflowRun, graph: WorkflowGraph, node: CanvasNode): Promise<NodeExecutionResult> {
    let image = requireArtifact(inputs.image)
    const markFinal = asBoolean(config.markFinal)
    if (markFinal) image = await this.storage.updateArtifactStatus(image.id, 'final', { finalizedByRunId: run.id, finalizedAt: nowIso() })
    const placedNodeId = await this.placeOutputArtifact(graph, node, image, run.id, asString(config.placement, 'right'), asString(config.replaceNodeId))
    return { outputs: { artifact: image, placedNodeId } }
  }

  private async placeOutputArtifact(snapshot: WorkflowGraph, outputNode: CanvasNode, image: ArtifactRef, runId: string, placement: string, explicitTarget: string): Promise<string> {
    let current = await this.storage.loadGraph(snapshot.id)
    const existing = current.nodes.find((item) => item.data.config.generatedByRunId === runId && item.data.config.sourceOutputNodeId === outputNode.id)
    if (existing) return existing.id
    if (placement === 'replace') {
      const targetId = explicitTarget || findReplaceTarget(snapshot, outputNode.id)
      if (!targetId) throw new Error('Replace placement requires replaceNodeId or an upstream canvas image node.')
      const target = current.nodes.find((item) => item.id === targetId)
      if (!target) throw new Error(`Replace target no longer exists in the current graph: ${targetId}`)
      current = await this.storage.applyPatch({
        transactionId: `replace-${runId}-${nanoid(6)}`, baseRevision: current.revision,
        operations: [{ op: 'updateNode', nodeId: targetId, patch: {
          config: { ...target.data.config, artifactId: image.id, generatedByRunId: runId, sourceOutputNodeId: outputNode.id },
          previewArtifactId: image.id, outputs: { image }, status: 'completed', statusMessage: `由 ${outputNode.id} 原位替换`, lastRunId: runId
        } }]
      })
      return current.nodes.find((item) => item.id === targetId)!.id
    }
    const anchor = current.nodes.find((item) => item.id === outputNode.id)
    const width = Math.min(520, Math.max(280, image.width ? image.width / 3 : 380))
    const height = image.width && image.height ? width * image.height / image.width : width
    const position = placement === 'below'
      ? { x: anchor?.position.x ?? 100, y: (anchor?.position.y ?? 100) + (anchor?.height || 220) + 90 }
      : { x: (anchor?.position.x ?? maxGraphX(current)) + (anchor?.width || 300) + 100, y: anchor?.position.y ?? 80 }
    const id = `node-image-${nanoid(10)}`
    await this.storage.applyPatch({
      transactionId: `place-${runId}-${nanoid(6)}`, baseRevision: current.revision,
      operations: [{ op: 'addNode', node: {
        id, type: 'workflow', position, width, height,
        data: {
          nodeType: 'canvas.image', label: image.status === 'final' ? '最终版本' : '生成结果',
          config: { artifactId: image.id, generatedByRunId: runId, sourceOutputNodeId: outputNode.id },
          status: 'completed', statusMessage: `由 ${outputNode.id} 输出`, outputs: { image }, previewArtifactId: image.id, lastRunId: runId, freeform: true
        }
      } }]
    })
    return id
  }

  private async requireArtifact(id: string): Promise<ArtifactRef> {
    if (!id) throw new Error('Artifact ID is required.')
    const artifact = await this.storage.getArtifact(id)
    if (!artifact) throw new Error(`Artifact not found: ${id}`)
    return artifact
  }

  private async promptArchitectWithLLM(brief: string, config: Record<string, unknown>, references: ArtifactRef[], signal: AbortSignal): Promise<{ promptSpec: PromptSpec; cost: number | undefined }> {
    const schema = promptSpecJsonSchema()
    const prompt = [
      'You are the VibeCanvas prompt architect. Return a precise structured visual specification and a production-ready prompt for the active image model.',
      `Creative brief: ${brief}`, `Strategy: ${asString(config.strategy, 'dynamic')}`, `Extra constraints: ${asString(config.extraConstraints)}`,
      `Reference roles: ${references.map((item) => `${item.fileName} (${String(item.metadata?.role ?? 'reference')})`).join('; ') || 'none'}`
    ].join('\n')
    const images: Array<{ mime: string; base64: string; filename?: string }> = []
    for (const [index, reference] of references.slice(0, 6).entries()) {
      if (signal.aborted) throw new DOMException('Run cancelled.', 'AbortError')
      const preview = await sharp(reference.filePath).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer()
      images.push({ mime: 'image/jpeg', base64: preview.toString('base64'), filename: `reference-${index + 1}.jpg` })
    }
    const response = await this.architectLLM.generateStructured({ prompt, images, schema, signal })
    const parsed = promptSpecSchema.safeParse(response.structured)
    if (!parsed.success) throw new Error(`LLM returned an invalid PromptSpec: ${parsed.error.message}`)
    return { promptSpec: parsed.data, cost: response.cost }
  }

  private async visionReviewWithLLM(images: ArtifactRef[], brief: string, minimumScore: number, signal: AbortSignal): Promise<{ report: EvaluationReport; cost: number | undefined }> {
    const llmImages: Array<{ mime: string; base64: string; filename?: string }> = []
    for (const [index, image] of images.entries()) {
      const preview = await sharp(image.filePath).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer()
      llmImages.push({ mime: 'image/jpeg', base64: preview.toString('base64'), filename: `candidate-${index + 1}.jpg` })
    }
    const prompt = [
      'You are VibeCanvas Agent Vision Review. Compare every attached candidate image.',
      `Creative brief: ${brief || 'No separate brief was provided; judge general professional visual quality.'}`,
      `Minimum acceptable score: ${minimumScore}.`,
      'Check subject correctness, composition, anatomy and geometry, visible text accuracy, material and lighting coherence, reference adherence, artifacts, watermarks, annotation residue, and suitability for the stated use.',
      'Return the zero-based selectedIndex, a 0-100 score, decision pass/retry/manual, concrete issues, and a targeted repairPrompt when needed.'
    ].join('\n')
    const response = await this.reviewerLLM.generateStructured({
      prompt, images: llmImages, schema: evaluationJsonSchema(), signal
    })
    const parsed = evaluationReportSchema.safeParse(response.structured)
    if (!parsed.success) throw new Error(`LLM returned an invalid vision review: ${parsed.error.message}`)
    if (parsed.data.selectedIndex >= images.length) throw new Error(`LLM selected candidate index ${parsed.data.selectedIndex}, but only ${images.length} images exist.`)
    return { report: { ...parsed.data, reviewer: 'agent', semanticScore: parsed.data.score }, cost: response.cost }
  }

  private async cacheKey(node: CanvasNode, inputs: Record<string, unknown>): Promise<string> {
    const definition = getNodeDefinition(node.data.nodeType)
    return sha256(stableStringify({ nodeType: node.data.nodeType, version: definition?.version, config: node.data.config, inputs: normalizeCacheValue(inputs), provider: this.config.image.id, model: this.config.image.model }))
  }

  private emitEvent(event: RunEvent): void {
    void this.storage.appendRunEvent(event).catch((error) => this.emit('error', new Error(`Failed to persist run event: ${error instanceof Error ? error.message : String(error)}`)))
    this.emit('event', event)
  }
}

function shouldCache(node: CanvasNode): boolean { return !['control.human-select', 'output.canvas', 'workflow.subflow'].includes(node.data.nodeType) }
function flattenValue(value: unknown): unknown[] { return Array.isArray(value) ? value.flatMap(flattenValue) : value === undefined ? [] : [value] }
function normalizeCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCacheValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.sha256 === 'string') return { id: record.id, sha256: record.sha256 }
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizeCacheValue(item)]))
  }
  return value
}

function buildPromptSpec(brief: string, config: Record<string, unknown>, references: ArtifactRef[]): PromptSpec {
  const strategy = asString(config.strategy, 'dynamic')
  const extra = asString(config.extraConstraints)
  const referenceText = references.length ? `Use ${references.length} supplied reference image(s) according to their declared roles; preserve requested identity without copying filenames, watermarks, annotations, or interface chrome.` : ''
  return {
    subject: brief.slice(0, 160), purpose: 'VibeCanvas visual creation', composition: 'Purpose-driven composition selected dynamically from the brief.',
    lighting: 'Controlled coherent lighting appropriate to the selected style.', style: strategy,
    preserve: references.length ? ['Identity and important visual features from declared subject references'] : [],
    avoid: ['watermarks', 'editor chrome', 'annotation arrows', 'garbled text', 'unrequested duplicated objects'],
    finalPrompt: [brief.trim(), strategy === 'creative' ? 'Explore a distinctive coherent visual concept while keeping the brief recognizable.' : '', strategy === 'faithful' ? 'Follow the brief literally and avoid unrequested changes.' : 'Make expert visual decisions for composition, lighting, materials, hierarchy, and negative space.', referenceText, extra, 'Produce a polished final bitmap with coherent anatomy and geometry, clean edges, intentional lighting, consistent materials, no watermarks, no editor UI, and no accidental pseudo-text.'].filter(Boolean).join('\n\n')
  }
}

async function technicalReview(images: ArtifactRef[], minimumScore: number): Promise<EvaluationReport> {
  const scored: Array<{ index: number; score: number; issues: EvaluationReport['issues'] }> = []
  for (const [index, image] of images.entries()) {
    const issues: EvaluationReport['issues'] = []
    let score = 45
    if ((image.width ?? 0) >= 1024 || (image.height ?? 0) >= 1024) score += 20
    else issues.push({ code: 'resolution', severity: 'warning', message: '图片最长边低于 1024px。' })
    if (image.sizeBytes > 100_000) score += 10
    else issues.push({ code: 'file-size', severity: 'warning', message: '图片文件异常偏小，可能细节不足。' })
    try {
      const stats = await sharp(image.filePath).stats()
      const entropy = stats.entropy ?? 0
      score += Math.min(25, entropy * 4)
      if (entropy < 2.5) issues.push({ code: 'low-entropy', severity: 'error', message: '画面信息量过低，可能是空白图、纯色图或错误占位图。' })
    } catch {
      issues.push({ code: 'decode', severity: 'error', message: '无法解码图片。' }); score -= 50
    }
    scored.push({ index, score: Math.max(0, Math.min(100, Math.round(score))), issues })
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  return {
    decision: best.score >= minimumScore && !best.issues.some((item) => item.severity === 'error') ? 'pass' : 'manual', selectedIndex: best.index, score: best.score,
    technicalScore: best.score, reviewer: 'technical', issues: best.issues,
    repairPrompt: best.score >= minimumScore ? undefined : 'Increase visual clarity, coherent detail, material definition, and composition quality while preserving the creative brief.'
  }
}

function combineReviews(technical: EvaluationReport, semantic: EvaluationReport, minimumScore: number): EvaluationReport {
  const score = Math.round((technical.score * 0.35) + (semantic.score * 0.65))
  const errors = [...technical.issues, ...semantic.issues].some((item) => item.severity === 'error')
  return {
    ...semantic, score, technicalScore: technical.score, semanticScore: semantic.score, reviewer: 'hybrid',
    decision: score >= minimumScore && !errors ? semantic.decision === 'retry' ? 'retry' : 'pass' : semantic.decision === 'retry' ? 'retry' : 'manual',
    issues: [...technical.issues, ...semantic.issues]
  }
}

function injectSubworkflowInput(graph: WorkflowGraph, explicitNodeId: string, value: unknown): void {
  if (value === undefined) return
  const target = explicitNodeId ? graph.nodes.find((node) => node.id === explicitNodeId) : graph.nodes.find((node) => ['input.brief', 'input.prompt', 'input.image'].includes(node.data.nodeType))
  if (!target) throw new Error('Subworkflow received input but no compatible input node was found. Configure inputNodeId.')
  const flattened = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (['input.brief', 'input.prompt'].includes(target.data.nodeType)) target.data.config = { ...target.data.config, text: asString(flattened) }
  else if (target.data.nodeType === 'input.image') target.data.config = { ...target.data.config, artifactId: requireArtifact(flattened).id }
  else target.data.config = { ...target.data.config, injectedInput: flattened }
}

function findReplaceTarget(graph: WorkflowGraph, outputNodeId: string): string | undefined {
  const ancestors = new Set<string>([outputNodeId]); let changed = true
  while (changed) { changed = false; for (const edge of graph.edges) if (ancestors.has(edge.target) && !ancestors.has(edge.source)) { ancestors.add(edge.source); changed = true } }
  const candidates = graph.nodes.filter((node) => ancestors.has(node.id) && ['canvas.image', 'input.image'].includes(node.data.nodeType))
  if (candidates.length > 1) throw new Error(`Replace target is ambiguous: ${candidates.map((item) => item.id).join(', ')}. Configure replaceNodeId explicitly.`)
  return candidates[0]?.id
}
function maxGraphX(graph: WorkflowGraph): number { return graph.nodes.reduce((max, node) => Math.max(max, node.position.x + (node.width || 320)), 0) }
function normalizeRatio(width: unknown, height: unknown): { width: number; height: number; label: string } { const w = normalizeEdge(asNumber(width, 1024)); const h = normalizeEdge(asNumber(height, 1024)); return { width: w, height: h, label: `${w}:${h}` } }
function normalizeRatioFromUnknown(value: unknown, fallbackWidth = 1024, fallbackHeight = 1024) { if (value && typeof value === 'object') { const record = value as Record<string, unknown>; return normalizeRatio(record.width ?? fallbackWidth, record.height ?? fallbackHeight) } return normalizeRatio(fallbackWidth, fallbackHeight) }
function normalizeEdge(value: number): number { return Math.max(16, Math.min(3840, Math.round(value / 16) * 16)) }
function requirePromptSpec(value: unknown): PromptSpec { const parsed = promptSpecSchema.safeParse(value); if (parsed.success) return parsed.data; if (typeof value === 'string') return { subject: value.slice(0, 160), finalPrompt: value }; throw new Error('缺少有效 PromptSpec。') }
function requireArtifact(value: unknown): ArtifactRef { if (value && typeof value === 'object' && typeof (value as ArtifactRef).id === 'string') return value as ArtifactRef; throw new Error('缺少图片 Artifact。') }
function asOptionalArtifact(value: unknown): ArtifactRef | undefined { try { return requireArtifact(value) } catch { return undefined } }
function asArtifacts(value: unknown): ArtifactRef[] { if (!value) return []; if (Array.isArray(value)) return value.flatMap(asArtifacts); if (typeof value === 'object' && typeof (value as ArtifactRef).id === 'string') return [value as ArtifactRef]; return [] }
function asString(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value) }
function asNumber(value: unknown, fallback = 0): number { const number = Number(value); return Number.isFinite(number) ? number : fallback }
function asBoolean(value: unknown, fallback = false): boolean { return value === undefined ? fallback : value === true || value === 'true' }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.floor(value))) }
function roundMoney(value: number): number { return Math.round(value * 1_000_000) / 1_000_000 }
function promptSpecJsonSchema() { return { type: 'object', properties: { subject: { type: 'string' }, purpose: { type: 'string' }, composition: { type: 'string' }, camera: { type: 'string' }, lighting: { type: 'string' }, materials: { type: 'array', items: { type: 'string' } }, palette: { type: 'array', items: { type: 'string' } }, style: { type: 'string' }, textRequirements: { type: 'array', items: { type: 'string' } }, preserve: { type: 'array', items: { type: 'string' } }, avoid: { type: 'array', items: { type: 'string' } }, aspectRatio: { type: 'string' }, finalPrompt: { type: 'string' } }, required: ['subject', 'finalPrompt'], additionalProperties: false } }
function evaluationJsonSchema() { return { type: 'object', properties: { decision: { type: 'string', enum: ['pass', 'retry', 'manual'] }, selectedIndex: { type: 'integer', minimum: 0 }, score: { type: 'number', minimum: 0, maximum: 100 }, issues: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning', 'error'] }, message: { type: 'string' } }, required: ['code', 'severity', 'message'], additionalProperties: false } }, repairPrompt: { type: 'string' } }, required: ['decision', 'selectedIndex', 'score', 'issues'], additionalProperties: false } }
