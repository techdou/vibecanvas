import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeConfig } from '../src/core/config.js'
import { defaultProviderProfile } from '../src/core/config.js'
import type { ImageProviderProfile, WorkflowRun } from '../src/core/types.js'
import { WorkspaceStorage } from '../src/core/storage.js'

export async function tempWorkspace(prefix = 'vibecanvas-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  const storage = new WorkspaceStorage(dir)
  await storage.init()
  return { dir, storage }
}

export function makeProfile(overrides: Partial<ImageProviderProfile> = {}): ImageProviderProfile {
  const base = defaultProviderProfile()
  return {
    ...base,
    ...overrides,
    headers: { ...base.headers, ...(overrides.headers || {}) },
    downloadHeaders: { ...base.downloadHeaders, ...(overrides.downloadHeaders || {}) },
    extraJson: { ...base.extraJson, ...(overrides.extraJson || {}) },
    capabilities: { ...base.capabilities, ...(overrides.capabilities || {}) },
    costs: { ...base.costs, ...(overrides.costs || {}) }
  }
}

export function makeRuntimeConfig(projectDir: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const base: RuntimeConfig = {
    projectDir,
    configFile: path.join(projectDir, 'config.json'),
    host: '127.0.0.1',
    port: 0,
    concurrency: 1,
    leaseSeconds: 10,
    image: makeProfile(),
    llm: {
      architect: { provider: 'fallback' },
      reviewer: { provider: 'fallback' }
    }
  }
  return {
    ...base,
    ...overrides,
    image: overrides.image ?? base.image,
    llm: overrides.llm ?? base.llm
  }
}

export async function waitForRun(storage: WorkspaceStorage, runId: string, statuses: WorkflowRun['status'][] = ['completed', 'failed', 'cancelled', 'needs-input'], timeoutMs = 10000): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await storage.loadRun(runId)
    if (run && statuses.includes(run.status)) return run
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for run ${runId}`)
}
