import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getRuntimeConfig } from '../src/core/config.js'
import { validateGraph } from '../src/core/graph.js'
import { Image2Provider } from '../src/core/image-provider.js'
import { WorkspaceStorage } from '../src/core/storage.js'

const config = await getRuntimeConfig()
const storage = new WorkspaceStorage(config.projectDir)
await storage.init()
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const nodeVersion = process.versions.node.split('.').map(Number)
const nodeSupported = nodeVersion[0] > 22 || nodeVersion[0] === 22 && nodeVersion[1] >= 5
const db = await storage.databaseDiagnostics()

checks.push({ name: 'Node.js', ok: nodeSupported, detail: `${process.version} (requires >=22.5 for node:sqlite)` })
checks.push({ name: 'Project directory', ok: true, detail: storage.projectDir })
checks.push({ name: 'SQLite WAL database', ok: db.journalMode.toLowerCase() === 'wal', detail: `${storage.databaseFile} · journal=${db.journalMode} · schema=${db.userVersion}` })
checks.push({ name: 'SQLite foreign keys', ok: db.foreignKeys, detail: String(db.foreignKeys) })
checks.push({ name: 'Unified config', ok: true, detail: config.configFile })
checks.push({ name: 'Image API token', ok: Boolean(config.image.apiKey), detail: config.image.apiKey ? 'configured' : 'missing (generation will be disabled)' })
checks.push({ name: 'Image API base URL', ok: Boolean(config.image.baseUrl), detail: config.image.baseUrl })
const validation = validateGraph(await storage.loadGraph())
checks.push({ name: 'Workflow graph', ok: validation.valid, detail: validation.valid ? `${validation.executionOrder.length} nodes in topology` : validation.problems.map((item) => item.message).join('; ') })
try {
  await access(path.resolve('dist/web/index.html'))
  checks.push({ name: 'Production web build', ok: true, detail: 'dist/web/index.html exists' })
} catch {
  checks.push({ name: 'Production web build', ok: false, detail: 'run npm run build' })
}

if (process.argv.includes('--probe-provider')) {
  if (!config.image.apiKey) checks.push({ name: 'Provider probe', ok: false, detail: 'IMAGE_API_KEY is not configured' })
  else {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'vibecanvas-provider-probe-'))
    const probeStorage = new WorkspaceStorage(temp)
    try {
      await probeStorage.init()
      const provider = new Image2Provider(config.image, probeStorage)
      const result = await provider.generate({
        prompt: 'A minimal neutral ceramic sphere on a clean warm-white background, centered, no text, provider connectivity test.',
        width: 512, height: 512, quality: 'low', candidateCount: 1,
        runId: `probe-${Date.now()}`, nodeId: 'provider-probe'
      })
      checks.push({ name: 'Provider probe', ok: result.artifacts.length === 1, detail: `generate=true · edit=${config.image.capabilities.imageToImage} · response=${result.artifacts[0]?.mimeType}` })
    } catch (error) {
      checks.push({ name: 'Provider probe', ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      probeStorage.close(); await rm(temp, { recursive: true, force: true })
    }
  }
}

for (const check of checks) console.log(`${check.ok ? 'PASS' : 'WARN'}  ${check.name}: ${check.detail}`)
const soft = new Set(['Image API token', 'Production web build'])
const hardFailure = checks.some((check) => !check.ok && !soft.has(check.name))
storage.close()
process.exitCode = hardFailure ? 1 : 0
