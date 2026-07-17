import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { config as loadDotenv } from 'dotenv'
import type { ImageProviderProfile, LLMProfile, VibeCanvasConfigFile } from './types.js'

export interface RuntimeConfig {
  projectDir: string
  configFile: string
  host: string
  port: number
  concurrency: number
  leaseSeconds: number
  image: ImageProviderProfile
  llm: VibeCanvasConfigFile['llm']
}

export function defaultConfigPath(): string {
  if (process.env.VIBECANVAS_CONFIG_FILE) return resolve(process.env.VIBECANVAS_CONFIG_FILE)
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'VibeCanvas', 'config.json')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vibecanvas', 'config.json')
}

export function defaultProviderProfile(): ImageProviderProfile {
  return {
    id: 'default-image2',
    label: 'Image 2 Relay',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2',
    generatePath: '/images/generations',
    editPath: '/images/edits',
    timeoutMs: 180000,
    maxRetries: 3,
    editImageField: 'image[]',
    outputFormat: 'png',
    headers: {},
    downloadHeaders: {},
    extraJson: {},
    allowPrivateImageUrls: false,
    allowedImageHosts: [],
    capabilities: {
      textToImage: true,
      imageToImage: true,
      multiReference: true,
      maskEdit: true,
      customSize: true,
      transparentBackground: false,
      batchN: false,
      responseFormats: ['b64_json', 'url'],
      maxReferences: 10,
      maxCandidates: 4
    },
    costs: { low: 0, medium: 0, high: 0, auto: 0, editMultiplier: 1 }
  }
}

export function defaultLLMProfile(): LLMProfile {
  // Default to fallback so a fresh install works without any LLM configuration.
  // The Prompt Architect node uses its deterministic buildPromptSpec, and the
  // Vision Review node uses technicalReview (image statistics only).
  return { provider: 'fallback' }
}

export function defaultConfigFile(): VibeCanvasConfigFile {
  const provider = defaultProviderProfile()
  return {
    version: 1,
    activeProviderId: provider.id,
    providers: { [provider.id]: provider },
    llm: { architect: defaultLLMProfile(), reviewer: defaultLLMProfile() },
    runtime: { host: '127.0.0.1', port: 43120, concurrency: 1, leaseSeconds: 30 }
  }
}

export class ConfigStore {
  readonly filePath: string
  constructor(filePath = defaultConfigPath()) { this.filePath = resolve(filePath) }

  async load(): Promise<VibeCanvasConfigFile> {
    await this.ensure()
    const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<VibeCanvasConfigFile>
    return mergeConfig(defaultConfigFile(), raw)
  }

  async save(config: VibeCanvasConfigFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
    await rename(tmp, this.filePath)
  }

  async updateProvider(profile: ImageProviderProfile, makeActive = true): Promise<VibeCanvasConfigFile> {
    const config = await this.load()
    config.providers[profile.id] = profile
    if (makeActive) config.activeProviderId = profile.id
    await this.save(config)
    return config
  }

  async ensure(): Promise<void> {
    try { await readFile(this.filePath) } catch { await this.save(defaultConfigFile()) }
  }
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const configFile = defaultConfigPath()
  loadDotenv({ path: resolve(process.cwd(), '.env'), quiet: true })
  loadDotenv({ path: join(dirname(configFile), '.env'), quiet: true, override: false })
  const store = new ConfigStore(configFile)
  const file = await store.load()
  const active = structuredClone(file.providers[file.activeProviderId] || defaultProviderProfile())
  applyProviderEnv(active)
  return {
    projectDir: resolve(process.env.VIBECANVAS_PROJECT_DIR || process.cwd()),
    configFile,
    host: process.env.VIBECANVAS_HOST || file.runtime.host,
    port: Number(process.env.VIBECANVAS_PORT || file.runtime.port),
    concurrency: Math.max(1, Number(process.env.VIBECANVAS_CONCURRENCY || file.runtime.concurrency)),
    leaseSeconds: Math.max(10, Number(process.env.VIBECANVAS_LEASE_SECONDS || file.runtime.leaseSeconds)),
    image: active,
    llm: {
      architect: applyLLMEnv(file.llm.architect, 'ARCHITECT'),
      reviewer: applyLLMEnv(file.llm.reviewer, 'REVIEWER')
    }
  }
}

/**
 * Overlay environment variables onto an LLM profile. The VIBECANVAS_LLM_<ROLE>_*
 * family is canonical; legacy OPENCODE_* variables are preserved as the source
 * for an opencode-session profile so existing setups keep working.
 */
function applyLLMEnv(profile: LLMProfile, role: 'ARCHITECT' | 'REVIEWER'): LLMProfile {
  const provider = process.env[`VIBECANVAS_LLM_${role}_PROVIDER`] as LLMProfile['provider'] | undefined
  const baseUrl = process.env[`VIBECANVAS_LLM_${role}_BASE_URL`]
  const apiKey = process.env[`VIBECANVAS_LLM_${role}_API_KEY`]
  const model = process.env[`VIBECANVAS_LLM_${role}_MODEL`]
  const headersJson = process.env[`VIBECANVAS_LLM_${role}_HEADERS_JSON`]
  const merged: LLMProfile = { ...profile }
  if (provider) merged.provider = provider
  if (baseUrl) merged.baseUrl = baseUrl.replace(/\/$/, '')
  if (apiKey) merged.apiKey = apiKey
  if (model) merged.model = model
  if (headersJson) merged.headers = { ...(merged.headers || {}), ...parseStringMap(headersJson) }
  // Legacy OPENCODE_* variables feed the opencode-session provider when the
  // profile has not been migrated to the new env names.
  if (merged.provider === 'opencode-session') {
    if (process.env.OPENCODE_BASE_URL) merged.baseUrl = process.env.OPENCODE_BASE_URL.replace(/\/$/, '')
    if (process.env.OPENCODE_SESSION_ID) merged.sessionId = process.env.OPENCODE_SESSION_ID
    if (process.env.OPENCODE_SERVER_USERNAME) merged.username = process.env.OPENCODE_SERVER_USERNAME
    if (process.env.OPENCODE_SERVER_PASSWORD) merged.password = process.env.OPENCODE_SERVER_PASSWORD
  }
  return merged
}

function applyProviderEnv(profile: ImageProviderProfile): void {
  profile.apiKey = process.env.IMAGE_API_KEY || profile.apiKey
  profile.baseUrl = (process.env.IMAGE_API_BASE_URL || profile.baseUrl).replace(/\/$/, '')
  profile.model = process.env.IMAGE_API_MODEL || profile.model
  profile.generatePath = process.env.IMAGE_API_GENERATE_PATH || process.env.IMAGE_API_GENERATIONS_PATH || profile.generatePath
  profile.editPath = process.env.IMAGE_API_EDIT_PATH || process.env.IMAGE_API_EDITS_PATH || profile.editPath
  profile.timeoutMs = Number(process.env.IMAGE_API_TIMEOUT_MS || profile.timeoutMs)
  profile.maxRetries = Number(process.env.IMAGE_API_MAX_RETRIES || profile.maxRetries)
  profile.editImageField = process.env.IMAGE_API_EDIT_IMAGE_FIELD || profile.editImageField
  profile.outputFormat = process.env.IMAGE_API_OUTPUT_FORMAT || profile.outputFormat
  profile.extraJson = { ...profile.extraJson, ...parseJsonObject(process.env.IMAGE_API_EXTRA_JSON) }
  profile.headers = { ...profile.headers, ...parseStringMap(process.env.IMAGE_API_HEADERS_JSON) }
  profile.downloadHeaders = { ...profile.downloadHeaders, ...parseStringMap(process.env.IMAGE_API_DOWNLOAD_HEADERS_JSON) }
  if (process.env.IMAGE_API_ALLOW_PRIVATE_URLS) profile.allowPrivateImageUrls = process.env.IMAGE_API_ALLOW_PRIVATE_URLS === 'true'
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {}
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}

function parseStringMap(raw: string | undefined): Record<string, string> {
  const value = parseJsonObject(raw)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}

function mergeConfig(base: VibeCanvasConfigFile, value: Partial<VibeCanvasConfigFile>): VibeCanvasConfigFile {
  const providers: Record<string, ImageProviderProfile> = { ...base.providers }
  for (const [id, profile] of Object.entries(value.providers || {})) {
    const fallback = defaultProviderProfile()
    providers[id] = {
      ...fallback,
      ...profile,
      id,
      headers: { ...fallback.headers, ...(profile.headers || {}) },
      downloadHeaders: { ...fallback.downloadHeaders, ...(profile.downloadHeaders || {}) },
      extraJson: { ...fallback.extraJson, ...(profile.extraJson || {}) },
      capabilities: { ...fallback.capabilities, ...(profile.capabilities || {}) },
      costs: { ...fallback.costs, ...(profile.costs || {}) }
    }
  }
  return {
    version: 1,
    activeProviderId: value.activeProviderId && providers[value.activeProviderId] ? value.activeProviderId : base.activeProviderId,
    providers,
    llm: {
      architect: mergeLLMProfile(base.llm.architect, value.llm?.architect),
      reviewer: mergeLLMProfile(base.llm.reviewer, value.llm?.reviewer)
    },
    runtime: { ...base.runtime, ...(value.runtime || {}) }
  }
}

function mergeLLMProfile(base: LLMProfile, value?: Partial<LLMProfile>): LLMProfile {
  if (!value) return base
  const merged: LLMProfile = { ...base, ...value }
  if (value.headers || base.headers) merged.headers = { ...(base.headers || {}), ...(value.headers || {}) }
  return merged
}

export function redactConfig(config: VibeCanvasConfigFile): VibeCanvasConfigFile {
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, profile]) => [id, {
      ...profile,
      apiKey: profile.apiKey ? '********' : '',
      headers: redactHeaders(profile.headers),
      downloadHeaders: redactHeaders(profile.downloadHeaders)
    }])),
    llm: {
      architect: redactLLMProfile(config.llm.architect),
      reviewer: redactLLMProfile(config.llm.reviewer)
    }
  }
}

function redactLLMProfile(profile: LLMProfile): LLMProfile {
  return {
    ...profile,
    apiKey: profile.apiKey ? '********' : undefined,
    password: profile.password ? '********' : undefined,
    headers: redactHeaders(profile.headers || {})
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => /authorization|token|key|secret|cookie/i.test(key) ? [key, '********'] : [key, value]))
}
