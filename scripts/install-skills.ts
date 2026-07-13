import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { defaultConfigPath } from '../src/core/config.js'
import path from 'node:path'

const args = process.argv.slice(2)
const scope = args.includes('--global') ? 'global' : 'project'
const targetArg = valueAfter(args, '--target')
const projectDir = path.resolve(valueAfter(args, '--project') || process.cwd())
const source = path.resolve('skills')
const target = targetArg
  ? path.resolve(targetArg)
  : scope === 'global'
    ? path.join(os.homedir(), '.agents', 'skills')
    : path.join(projectDir, '.agents', 'skills')

await mkdir(target, { recursive: true })
for (const name of ['vibecanvas', 'vibecanvas-workflow-compose', 'vibecanvas-image-generate', 'vibecanvas-image-edit', 'vibecanvas-creative-review']) {
  await cp(path.join(source, name), path.join(target, name), { recursive: true, force: true })
  console.log(`Installed ${name} -> ${path.join(target, name)}`)
}

if (args.includes('--write-opencode')) {
  const configPath = path.join(projectDir, 'opencode.json')
  let config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' }
  try { config = JSON.parse(await readFile(configPath, 'utf8')) } catch { /* create */ }
  const mcp = (config.mcp && typeof config.mcp === 'object' ? config.mcp : {}) as Record<string, unknown>
  mcp.vibecanvas = {
    type: 'local',
    command: ['node', path.resolve('dist/node/mcp.js')],
    cwd: projectDir,
    enabled: true,
    environment: { VIBECANVAS_PROJECT_DIR: projectDir, VIBECANVAS_CONFIG_FILE: defaultConfigPath() }
  }
  config.mcp = mcp
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Updated ${configPath}`)
}

function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag)
  return index >= 0 ? values[index + 1] : undefined
}
