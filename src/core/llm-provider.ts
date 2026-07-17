import { Buffer } from 'node:buffer'
import type { LLMProfile } from './types.js'
export type { LLMProfile }

/**
 * LLM provider profiles consumed by the runner. Each node (Prompt Architect,
 * Vision Review) gets its own profile so the reviewer can target a vision-capable
 * model while the architect targets a cheaper text model. The profile type itself
 * lives in types.ts so it can be referenced by VibeCanvasConfigFile without a
 * cycle.
 */

export interface LLMImageInput {
  mime: string
  base64: string
  filename?: string
}

export interface StructuredLLMRequest {
  system?: string
  prompt: string
  images?: LLMImageInput[]
  /** JSON schema constraining the model output. */
  schema: Record<string, unknown>
  signal?: AbortSignal
}

export interface StructuredLLMResponse {
  structured: unknown
  cost?: number
  raw: unknown
}

export interface LLMProvider {
  readonly kind: LLMProfile['provider']
  generateStructured(req: StructuredLLMRequest): Promise<StructuredLLMResponse>
}

/**
 * Build an LLM provider from a profile. Falls back to FallbackProvider when the
 * profile is misconfigured so the workflow keeps running with deterministic output
 * instead of crashing mid-run.
 */
export function createLLMProvider(profile: LLMProfile): LLMProvider {
  switch (profile.provider) {
    case 'openai-chat':
      if (!profile.baseUrl || !profile.apiKey || !profile.model) return new FallbackProvider()
      return new OpenAIChatProvider(profile)
    case 'opencode-session':
      if (!profile.baseUrl || !profile.sessionId) return new FallbackProvider()
      return new OpenCodeSessionProvider(profile)
    case 'fallback':
    default:
      return new FallbackProvider()
  }
}

/**
 * OpenAI-compatible chat completions provider. Works with OpenAI, Doubao (Ark),
 * GLM, Anthropic via OpenRouter, Ollama, vLLM, and any server that speaks
 * POST {baseUrl}/chat/completions with `response_format: json_schema`.
 */
export class OpenAIChatProvider implements LLMProvider {
  readonly kind = 'openai-chat' as const
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly maxRetries: number

  constructor(profile: LLMProfile) {
    this.baseUrl = (profile.baseUrl || '').replace(/\/$/, '')
    this.apiKey = profile.apiKey || ''
    this.model = profile.model || ''
    this.headers = profile.headers || {}
    this.timeoutMs = profile.requestTimeoutMs || 120000
    this.maxRetries = Math.max(0, Math.min(5, profile.maxRetries ?? 2))
  }

  async generateStructured(req: StructuredLLMRequest): Promise<StructuredLLMResponse> {
    const body = this.buildRequestBody(req)
    const url = `${this.baseUrl}/chat/completions`
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...this.headers },
          body: JSON.stringify(body),
          signal: req.signal
        }, this.timeoutMs)
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`OpenAI-chat LLM ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`)
        }
        const json = await response.json() as ChatCompletionResponse
        const structured = this.extractStructured(json)
        if (structured === undefined) throw new Error('LLM response did not contain parseable JSON.')
        return { structured, cost: this.extractCost(json), raw: json }
      } catch (error) {
        if (req.signal?.aborted) throw error
        lastError = error
        if (attempt < this.maxRetries) await sleep(Math.min(8000, 500 * 2 ** attempt))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`OpenAI-chat LLM failed: ${String(lastError)}`)
  }

  private buildRequestBody(req: StructuredLLMRequest): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const image of req.images || []) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } })
    }
    messages.push({ role: 'user', content: userContent.length === 1 ? req.prompt : userContent })
    return {
      model: this.model,
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'vibecanvas_output', schema: req.schema, strict: false } },
      temperature: 0.4
    }
  }

  private extractStructured(json: ChatCompletionResponse): unknown {
    const choice = json.choices?.[0]
    const content = choice?.message?.content
    if (!content) return undefined
    if (typeof content !== 'string') return undefined
    const trimmed = content.trim()
    try { return JSON.parse(trimmed) } catch { /* fall through */ }
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try { return JSON.parse(match[1].trim()) } catch { /* fall through */ }
    }
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) } catch { /* fall through */ }
    }
    return undefined
  }

  private extractCost(json: ChatCompletionResponse): number | undefined {
    return undefined
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const signal = init.signal ? mergeAbortSignals(init.signal, controller.signal) : controller.signal
    try {
      return await fetch(url, { ...init, signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * OpenCode session-based provider. Wraps the legacy opencode serve HTTP API
 * (POST /session/{id}/message or /prompt_async). Preserved so existing OpenCode
 * users can keep running reviewer/architect against an opencode server without
 * switching to a generic OpenAI-compat endpoint.
 */
export class OpenCodeSessionProvider implements LLMProvider {
  readonly kind = 'opencode-session' as const
  private readonly baseUrl: string
  private readonly sessionId: string
  private readonly username?: string
  private readonly password?: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number

  constructor(profile: LLMProfile) {
    this.baseUrl = (profile.baseUrl || '').replace(/\/$/, '')
    this.sessionId = profile.sessionId || ''
    this.username = profile.username
    this.password = profile.password
    this.headers = profile.headers || {}
    this.timeoutMs = profile.requestTimeoutMs || 120000
  }

  async generateStructured(req: StructuredLLMRequest): Promise<StructuredLLMResponse> {
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const image of req.images || []) {
      parts.push({ type: 'file', mime: image.mime, filename: image.filename, url: `data:${image.mime};base64,${image.base64}` })
    }
    const body: Record<string, unknown> = { parts, format: { type: 'json_schema', schema: req.schema, retryCount: 2 } }
    if (req.system) body.system = req.system
    const endpoint = `/session/${encodeURIComponent(this.sessionId)}/message`
    const json = await this.request(endpoint, body, req.signal)
    const structured = (json as { info?: { structured?: unknown; structured_output?: unknown } })?.info?.structured
      ?? (json as { info?: { structured?: unknown; structured_output?: unknown } })?.info?.structured_output
    if (structured === undefined) throw new Error('OpenCode session did not return structured output.')
    const cost = Number((json as { info?: { cost?: number } })?.info?.cost || 0) || undefined
    return { structured, cost, raw: json }
  }

  private async request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(this.headers)) headers.set(key, value)
    if (this.password) headers.set('authorization', `Basic ${Buffer.from(`${this.username || 'opencode'}:${this.password}`).toString('base64')}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const mergedSignal = signal ? mergeAbortSignals(signal, controller.signal) : controller.signal
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: mergedSignal })
      const text = await response.text()
      let value: unknown = text
      try { value = text ? JSON.parse(text) : null } catch { /* keep text */ }
      if (!response.ok) throw new Error(`OpenCode session ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`)
      return value
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Deterministic local provider. Always returns an empty structured object so the
 * caller (runner) can detect the fallback path and substitute its own buildPromptSpec
 * or technicalReview. The runner should branch on `provider.kind === 'fallback'`
 * rather than calling generateStructured when it wants the deterministic path; this
 * class exists so the LLMProvider interface stays uniform.
 */
export class FallbackProvider implements LLMProvider {
  readonly kind = 'fallback' as const
  async generateStructured(_req: StructuredLLMRequest): Promise<StructuredLLMResponse> {
    return { structured: {}, raw: { fallback: true } }
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { total_tokens?: number }
  [key: string]: unknown
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * Resolve when either signal aborts. Avoids depending on newer AbortSignal.any
 * so the code stays compatible with the current Node LTS feature set.
 */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (a.aborted || b.aborted) controller.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  controller.signal.addEventListener('abort', () => {
    a.removeEventListener('abort', onAbort)
    b.removeEventListener('abort', onAbort)
  })
  return controller.signal
}
