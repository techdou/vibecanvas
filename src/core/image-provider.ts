import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { ArtifactRef, ImageProviderProfile, PromptSpec, ProviderCapabilities } from './types.js'
import { WorkspaceStorage } from './storage.js'
import { ensureDir, nowIso, sha256 } from './utils.js'

export interface ImageProviderRequest {
  prompt: PromptSpec | string
  width: number
  height: number
  quality: string
  candidateCount: number
  outputFormat?: string
  runId: string
  nodeId: string
  source?: ArtifactRef
  references?: ArtifactRef[]
  mask?: ArtifactRef
  annotation?: ArtifactRef
  signal?: AbortSignal
}

interface ImageApiItem { b64_json?: string; url?: string; image_url?: string; revised_prompt?: string }
interface ApiCallResult { value: unknown; attempts: number; durationMs: number }

export class Image2Provider {
  constructor(private readonly config: ImageProviderProfile, private readonly storage: WorkspaceStorage) {}

  capabilities(): ProviderCapabilities { return structuredClone(this.config.capabilities) }

  estimateCost(operation: 'generate' | 'edit', quality: string, count: number): number {
    const key = ['low', 'medium', 'high', 'auto'].includes(quality) ? quality as keyof ImageProviderProfile['costs'] : 'high'
    const base = Number(this.config.costs[key] || 0)
    return roundMoney(base * count * (operation === 'edit' ? Number(this.config.costs.editMultiplier || 1) : 1))
  }

  async generate(request: ImageProviderRequest): Promise<{ artifacts: ArtifactRef[]; metadata: Record<string, unknown>; estimatedCostUsd: number }> {
    this.assertConfigured('generate')
    throwIfAborted(request.signal)
    const prompt = typeof request.prompt === 'string' ? request.prompt : request.prompt.finalPrompt
    const count = this.validateCandidateCount(request.candidateCount)
    const artifacts: ArtifactRef[] = []
    const responses: unknown[] = []
    let totalAttempts = 0
    let totalDurationMs = 0
    for (let index = 0; index < count; index += 1) {
      throwIfAborted(request.signal)
      const body: Record<string, unknown> = {
        ...this.config.extraJson,
        model: this.config.model,
        prompt,
        quality: request.quality || 'high',
        output_format: normalizeOutputFormat(request.outputFormat || this.config.outputFormat),
        n: 1
      }
      if (this.config.capabilities.customSize) body.size = normalizeImageSize(request.width, request.height)
      const call = await this.requestJson(joinUrl(this.config.baseUrl, this.config.generatePath), body, request.signal)
      totalAttempts += call.attempts; totalDurationMs += call.durationMs
      const items = normalizeResponseItems(call.value)
      if (!items.length) throw new Error('Image API returned no image data.')
      const outputPath = await this.persistImageItem(items[0], request, index)
      throwIfAborted(request.signal)
      const artifact = await this.storage.registerArtifact({
        filePath: outputPath, kind: 'image', status: 'candidate', runId: request.runId, nodeId: request.nodeId, parentArtifactIds: [],
        metadata: {
          operation: 'generate', providerProfileId: this.config.id, provider: 'openai-compatible', model: this.config.model,
          prompt, revisedPrompt: items[0].revised_prompt, requestedSize: `${request.width}x${request.height}`,
          quality: request.quality, apiAttempts: call.attempts, apiDurationMs: call.durationMs
        }
      })
      artifacts.push(artifact)
      responses.push({ revisedPrompt: items[0].revised_prompt, sha256: artifact.sha256 })
    }
    return {
      artifacts,
      estimatedCostUsd: this.estimateCost('generate', request.quality, artifacts.length),
      metadata: {
        operation: 'generate', providerProfileId: this.config.id, model: this.config.model, candidateCount: artifacts.length,
        promptHash: sha256(prompt), generatedAt: nowIso(), responses, apiAttempts: totalAttempts, apiDurationMs: totalDurationMs
      }
    }
  }

  async edit(request: ImageProviderRequest): Promise<{ artifacts: ArtifactRef[]; metadata: Record<string, unknown>; estimatedCostUsd: number }> {
    this.assertConfigured('edit')
    if (!request.source) throw new Error('Image edit requires a source image.')
    throwIfAborted(request.signal)
    const promptBase = typeof request.prompt === 'string' ? request.prompt : request.prompt.finalPrompt
    const annotationNotes = request.annotation?.metadata?.notes
    const annotationInstruction = typeof annotationNotes === 'string' && annotationNotes.trim()
      ? `\nStructured annotation notes:\n${annotationNotes.trim()}`
      : ''
    const prompt = request.annotation
      ? `${promptBase}\n\nUse the supplied annotation image as an edit brief. Apply the visible notes and marked regions, but remove every annotation mark, arrow, label, selection outline, and editor UI from the final image.${annotationInstruction}`
      : promptBase
    const references = request.references ?? []
    if (references.length > this.config.capabilities.maxReferences) throw new Error(`Provider supports at most ${this.config.capabilities.maxReferences} reference images.`)
    if (references.length && !this.config.capabilities.multiReference) throw new Error('The active provider profile does not support multiple reference images.')
    if (request.mask && !this.config.capabilities.maskEdit) throw new Error('The active provider profile does not support mask editing.')
    const count = this.validateCandidateCount(request.candidateCount)
    const prepared = await this.prepareEditInputs(request)
    const artifacts: ArtifactRef[] = []
    let totalAttempts = 0
    let totalDurationMs = 0
    for (let index = 0; index < count; index += 1) {
      throwIfAborted(request.signal)
      const form = new FormData()
      form.set('model', this.config.model)
      form.set('prompt', prompt)
      if (this.config.capabilities.customSize) form.set('size', normalizeImageSize(request.width, request.height))
      form.set('quality', request.quality || 'high')
      form.set('output_format', normalizeOutputFormat(request.outputFormat || this.config.outputFormat))
      for (const [key, value] of Object.entries(this.config.extraJson)) {
        if (value === undefined || value === null) continue
        form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
      for (const input of prepared.images) form.append(this.config.editImageField, new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }), input.fileName)
      if (prepared.annotation) form.append(this.config.editImageField, new Blob([new Uint8Array(prepared.annotation.buffer)], { type: prepared.annotation.mimeType }), prepared.annotation.fileName)
      if (prepared.mask) form.set('mask', new Blob([new Uint8Array(prepared.mask.buffer)], { type: prepared.mask.mimeType }), prepared.mask.fileName)
      const call = await this.requestForm(joinUrl(this.config.baseUrl, this.config.editPath), form, request.signal)
      totalAttempts += call.attempts; totalDurationMs += call.durationMs
      const items = normalizeResponseItems(call.value)
      if (!items.length) throw new Error('Image edit API returned no image data.')
      const outputPath = await this.persistImageItem(items[0], request, index)
      throwIfAborted(request.signal)
      const parents = [request.source, ...references, ...(request.annotation ? [request.annotation] : [])]
      const artifact = await this.storage.registerArtifact({
        filePath: outputPath, kind: 'image', status: 'candidate', runId: request.runId, nodeId: request.nodeId,
        parentArtifactIds: parents.map((item) => item.id),
        metadata: {
          operation: 'edit', providerProfileId: this.config.id, provider: 'openai-compatible', model: this.config.model,
          prompt, requestedSize: `${request.width}x${request.height}`, quality: request.quality,
          sourceArtifactId: request.source.id, referenceArtifactIds: references.map((item) => item.id),
          maskArtifactId: request.mask?.id, annotationArtifactId: request.annotation?.id,
          apiAttempts: call.attempts, apiDurationMs: call.durationMs
        }
      })
      artifacts.push(artifact)
    }
    return {
      artifacts,
      estimatedCostUsd: this.estimateCost('edit', request.quality, artifacts.length),
      metadata: {
        operation: 'edit', providerProfileId: this.config.id, model: this.config.model, candidateCount: artifacts.length,
        promptHash: sha256(prompt), generatedAt: nowIso(), apiAttempts: totalAttempts, apiDurationMs: totalDurationMs
      }
    }
  }

  private assertConfigured(operation: 'generate' | 'edit'): void {
    if (!this.config.apiKey) throw new Error('Image API key is not configured in the unified VibeCanvas provider profile.')
    if (!this.config.baseUrl) throw new Error('Image API base URL is not configured.')
    if (operation === 'generate' && !this.config.capabilities.textToImage) throw new Error('The active provider profile does not support text-to-image.')
    if (operation === 'edit' && !this.config.capabilities.imageToImage) throw new Error('The active provider profile does not support image editing.')
  }

  private validateCandidateCount(value: number): number {
    const max = Math.max(1, Math.min(this.config.capabilities.maxCandidates || 4, 20))
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Candidate count must be between 1 and ${max}.`)
    return value
  }

  private async prepareEditInputs(request: ImageProviderRequest): Promise<{
    images: Array<{ buffer: Buffer; mimeType: string; fileName: string }>
    mask?: { buffer: Buffer; mimeType: string; fileName: string }
    annotation?: { buffer: Buffer; mimeType: string; fileName: string }
  }> {
    const source = request.source!
    const references = request.references ?? []
    await assertEditInputSizes([source, ...references, ...(request.mask ? [request.mask] : []), ...(request.annotation ? [request.annotation] : [])])
    if (!request.mask) {
      return {
        images: await Promise.all([source, ...references].map(async (artifact, index) => ({
          buffer: await readFile(artifact.filePath), mimeType: artifact.mimeType, fileName: `${index === 0 ? 'source' : `reference-${index}`}${extensionForMime(artifact.mimeType)}`
        }))),
        annotation: request.annotation ? { buffer: await readFile(request.annotation.filePath), mimeType: request.annotation.mimeType, fileName: `annotation${extensionForMime(request.annotation.mimeType)}` } : undefined
      }
    }
    const sourceMeta = await sharp(source.filePath).metadata()
    const maskMeta = await sharp(request.mask.filePath).metadata()
    if (!sourceMeta.width || !sourceMeta.height || !maskMeta.width || !maskMeta.height) throw new Error('Could not read source or mask dimensions.')
    if (sourceMeta.width !== maskMeta.width || sourceMeta.height !== maskMeta.height) {
      throw new Error(`Mask dimensions must match the source image exactly: source=${sourceMeta.width}x${sourceMeta.height}, mask=${maskMeta.width}x${maskMeta.height}.`)
    }
    if (!maskMeta.hasAlpha) throw new Error('Mask must contain an alpha channel. Use the VibeCanvas Mask Editor to create a transparent PNG mask.')
    const sourcePng = await sharp(source.filePath).png().toBuffer()
    const maskPng = await sharp(request.mask.filePath).png().toBuffer()
    const imageInputs = [{ buffer: sourcePng, mimeType: 'image/png', fileName: 'source.png' }]
    for (const [index, reference] of references.entries()) imageInputs.push({ buffer: await readFile(reference.filePath), mimeType: reference.mimeType, fileName: `reference-${index + 1}${extensionForMime(reference.mimeType)}` })
    return {
      images: imageInputs,
      mask: { buffer: maskPng, mimeType: 'image/png', fileName: 'mask.png' },
      annotation: request.annotation ? { buffer: await readFile(request.annotation.filePath), mimeType: request.annotation.mimeType, fileName: `annotation${extensionForMime(request.annotation.mimeType)}` } : undefined
    }
  }

  private async persistImageItem(item: ImageApiItem, request: ImageProviderRequest, index: number): Promise<string> {
    throwIfAborted(request.signal)
    let buffer: Buffer
    if (item.b64_json) buffer = Buffer.from(item.b64_json, 'base64')
    else {
      const remoteUrl = item.url || item.image_url
      if (!remoteUrl) throw new Error('Image response item has neither b64_json nor URL.')
      buffer = await this.downloadRemoteImage(remoteUrl, request.signal)
    }
    const format = normalizeOutputFormat(request.outputFormat || this.config.outputFormat)
    const normalized = await normalizeAndValidateImage(buffer, format, request.width, request.height, request.signal)
    const outputDir = path.join(this.storage.runsDir, request.runId, request.nodeId)
    await ensureDir(outputDir)
    const outputPath = path.join(outputDir, `candidate-${String(index + 1).padStart(2, '0')}.${format === 'jpeg' ? 'jpg' : format}`)
    await writeFile(outputPath, normalized)
    return outputPath
  }

  private async downloadRemoteImage(rawUrl: string, signal?: AbortSignal): Promise<Buffer> {
    let current = new URL(rawUrl)
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const pinned = await assertSafeRemoteUrl(current, this.config)
      // Use the resolved IP directly in the URL to prevent DNS rebinding between validation and fetch.
      const pinnedUrl = pinned ? buildIpPinnedUrl(current, pinned) : current
      const headers = { ...this.config.downloadHeaders }
      if (pinned && current.hostname !== pinned) headers.host = current.host
      const response = await fetchWithTimeout(pinnedUrl.toString(), { method: 'GET', headers, redirect: 'manual' }, this.config.timeoutMs, signal)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error('Image download redirect did not include a Location header.')
        current = new URL(location, current)
        continue
      }
      if (!response.ok) throw new Error(`Failed to download image URL: ${response.status} ${response.statusText}`)
      const length = Number(response.headers.get('content-length') || 0)
      if (length > 80 * 1024 * 1024) throw new Error('Remote image exceeds the 80 MB safety limit.')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > 80 * 1024 * 1024) throw new Error('Remote image exceeds the 80 MB safety limit.')
      return buffer
    }
    throw new Error('Too many redirects while downloading generated image.')
  }

  private async requestJson(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ApiCallResult> {
    return this.withRetry(async () => {
      const response = await fetchWithTimeout(url, { method: 'POST', headers: this.apiHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }, this.config.timeoutMs, signal)
      return parseApiResponse(response)
    }, signal)
  }

  private async requestForm(url: string, form: FormData, signal?: AbortSignal): Promise<ApiCallResult> {
    return this.withRetry(async () => {
      const response = await fetchWithTimeout(url, { method: 'POST', headers: this.apiHeaders(), body: form }, this.config.timeoutMs, signal)
      return parseApiResponse(response)
    }, signal)
  }

  private apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers = { ...this.config.headers, ...extra }
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${this.config.apiKey}`
    return headers
  }

  private async withRetry<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<{ value: T; attempts: number; durationMs: number }> {
    const started = Date.now()
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      throwIfAborted(signal)
      try { return { value: await task(), attempts: attempt + 1, durationMs: Date.now() - started } }
      catch (error) {
        lastError = error
        if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortError(signal)
        if (!isRetryableError(error) || attempt >= this.config.maxRetries) break
        await abortableDelay(Math.min(1000 * 2 ** attempt + Math.random() * 250, 10000), signal)
      }
    }
    throw lastError
  }
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }

async function parseApiResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  let value: unknown = text
  try { value = text ? JSON.parse(text) : null } catch { /* keep text */ }
  if (!response.ok) throw new HttpError(response.status, `Image API request failed: ${response.status} ${response.statusText} - ${text.slice(0, 2000)}`)
  return value
}

function normalizeResponseItems(response: unknown): ImageApiItem[] {
  if (!response || typeof response !== 'object') return []
  const record = response as Record<string, unknown>
  const candidates = [record.data, record.images, record.output]
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate.filter((item) => item && typeof item === 'object') as ImageApiItem[]
  if (typeof record.b64_json === 'string' || typeof record.url === 'string') return [record as ImageApiItem]
  return []
}

export function normalizeImageSize(width: number, height: number): string {
  const w = Math.max(16, Math.min(3840, Math.round(width / 16) * 16))
  const h = Math.max(16, Math.min(3840, Math.round(height / 16) * 16))
  if (Math.max(w / h, h / w) > 3) throw new Error('Image aspect ratio may not exceed 3:1.')
  if (w * h < 4096 || w * h > 9_000_000) throw new Error('Image pixel count must be between 4,096 and 9,000,000.')
  return `${w}x${h}`
}

async function normalizeAndValidateImage(buffer: Buffer, format: string, targetWidth: number, targetHeight: number, signal?: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal)
  if (buffer.length < 1024) throw new Error('Image response is unexpectedly small and may be an error payload.')
  const head = buffer.subarray(0, 256).toString('utf8').trim().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) throw new Error('Image response contained an HTML error page.')
  let pipeline = sharp(buffer, { failOn: 'error' }).rotate()
  const input = await pipeline.metadata()
  if (!input.width || !input.height) throw new Error('Generated image has no readable dimensions.')
  const requestedRatio = targetWidth / targetHeight
  const actualRatio = input.width / input.height
  if (Math.abs(requestedRatio - actualRatio) / requestedRatio > 0.08) throw new Error(`Generated image ratio differs from requested ratio: requested ${targetWidth}x${targetHeight}, received ${input.width}x${input.height}.`)
  const targetPixels = targetWidth * targetHeight
  if (input.width * input.height < targetPixels * 0.25) throw new Error(`Generated image resolution is too small: requested ${targetWidth}x${targetHeight}, received ${input.width}x${input.height}.`)
  if (format === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 95 })
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 95 })
  else pipeline = pipeline.png()
  const output = await pipeline.toBuffer()
  throwIfAborted(signal)
  return output
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  return fetch(url, { ...init, signal: combined })
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
  return error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError'
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(signal) }
function abortError(signal?: AbortSignal): DOMException { return new DOMException(String(signal?.reason || 'The operation was aborted.'), 'AbortError') }
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError(signal)) }, { once: true })
  })
}

async function assertSafeRemoteUrl(url: URL, profile: ImageProviderProfile): Promise<string | undefined> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported image URL protocol: ${url.protocol}`)
  if (url.username || url.password) throw new Error('Generated image URLs may not contain embedded credentials.')
  const host = url.hostname.toLowerCase()
  if (profile.allowedImageHosts.length && !profile.allowedImageHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) throw new Error(`Image URL host is not allowed: ${host}`)
  if (profile.allowPrivateImageUrls) return undefined
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  for (const { address } of addresses) if (isPrivateAddress(address)) throw new Error(`Blocked private or local image URL address: ${address}`)
  // Return the first resolved IP so the caller can pin it in the fetch URL, closing the DNS rebinding window.
  return addresses[0]?.address
}

function buildIpPinnedUrl(url: URL, ip: string): URL {
  // For IPv6, the hostname must be bracketed in the URL.
  const bracketed = ip.includes(':') ? `[${ip}]` : ip
  const pinned = new URL(url.toString())
  pinned.hostname = bracketed
  return pinned
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase()
  if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice('::ffff:'.length))
  if (value === '::1' || value === '0:0:0:0:0:0:0:1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224
}

async function assertEditInputSizes(artifacts: ArtifactRef[]): Promise<void> {
  const limit = 50 * 1024 * 1024
  for (const artifact of artifacts) {
    const size = artifact.sizeBytes || (await import('node:fs/promises')).stat(artifact.filePath).then((item) => item.size)
    const resolved = typeof size === 'number' ? size : await size
    if (resolved > limit) throw new Error(`Edit input exceeds the 50 MB limit: ${artifact.fileName} (${resolved} bytes).`)
  }
}

function normalizeOutputFormat(value: string): 'png' | 'jpeg' | 'webp' {
  const format = value.toLowerCase().replace('jpg', 'jpeg')
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error(`Unsupported output format: ${value}`)
  return format as 'png' | 'jpeg' | 'webp'
}
function extensionForMime(mime: string): string { return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png' }
function joinUrl(base: string, endpoint: string): string { return `${base.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}` }
function roundMoney(value: number): number { return Math.round(value * 1_000_000) / 1_000_000 }
