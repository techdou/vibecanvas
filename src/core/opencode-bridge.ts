import type { RuntimeConfig } from './config.js'

export interface OpenCodeTextPartInput { type: 'text'; text: string }
export interface OpenCodeFilePartInput { type: 'file'; mime: string; filename?: string; url: string }
export type OpenCodePartInput = OpenCodeTextPartInput | OpenCodeFilePartInput

export interface OpenCodeMessageResponse {
  info?: { structured?: unknown; structured_output?: unknown; cost?: number; [key: string]: unknown }
  parts?: unknown[]
  [key: string]: unknown
}

export class OpenCodeBridge {
  constructor(private readonly config: RuntimeConfig['openCode']) {}

  async health(signal?: AbortSignal): Promise<unknown> { return this.request('/global/health', { method: 'GET', signal }) }

  async createSession(title = 'VibeCanvas Creative Session', signal?: AbortSignal): Promise<{ id: string; [key: string]: unknown }> {
    return this.request('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }), signal }) as Promise<{ id: string; [key: string]: unknown }>
  }

  async sendMessage(args: {
    sessionId?: string
    prompt?: string
    parts?: OpenCodePartInput[]
    agent?: string
    model?: { providerID: string; modelID: string }
    asynchronous?: boolean
    format?: Record<string, unknown>
    system?: string
    signal?: AbortSignal
  }): Promise<OpenCodeMessageResponse | null> {
    const sessionId = args.sessionId || this.config.sessionId
    if (!sessionId) throw new Error('OpenCode session ID is required. Configure it in the unified VibeCanvas config or create a session from the canvas.')
    const endpoint = args.asynchronous ? `/session/${encodeURIComponent(sessionId)}/prompt_async` : `/session/${encodeURIComponent(sessionId)}/message`
    const parts = args.parts?.length ? args.parts : [{ type: 'text' as const, text: args.prompt || '' }]
    if (!parts.length || !parts.some((part) => part.type !== 'text' || part.text.trim())) throw new Error('OpenCode message content is empty.')
    const body: Record<string, unknown> = { parts }
    if (args.agent || this.config.agent) body.agent = args.agent || this.config.agent
    if (args.model || this.config.model) body.model = args.model || this.config.model
    if (args.format) body.format = args.format
    if (args.system) body.system = args.system
    return this.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: args.signal }) as Promise<OpenCodeMessageResponse | null>
  }

  async abortSession(sessionId?: string, signal?: AbortSignal): Promise<boolean> {
    const id = sessionId || this.config.sessionId
    if (!id) return false
    return Boolean(await this.request(`/session/${encodeURIComponent(id)}/abort`, { method: 'POST', signal }))
  }

  async listSessions(signal?: AbortSignal): Promise<unknown> { return this.request('/session', { method: 'GET', signal }) }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers)
    if (this.config.password) headers.set('authorization', `Basic ${Buffer.from(`${this.config.username || 'opencode'}:${this.config.password}`).toString('base64')}`)
    const response = await fetch(`${this.config.baseUrl}${path}`, { ...init, headers })
    const text = await response.text()
    let value: unknown = text
    try { value = text ? JSON.parse(text) : null } catch { /* keep text */ }
    if (!response.ok) throw new Error(`OpenCode request failed: ${response.status} ${response.statusText} - ${text.slice(0, 1000)}`)
    return value
  }
}
