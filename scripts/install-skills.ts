import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { defaultConfigPath } from '../src/core/config.js'
import path from 'node:path'

/**
 * Install the VibeCanvas skills and generate per-agent MCP configuration files.
 *
 * Agents supported: zcode, opencode, claude-code. Each agent has a different
 * configuration file format and location, so we keep a small AgentEmitter
 * abstraction instead of branching inline for every supported host.
 *
 * Usage:
 *   tsx scripts/install-skills.ts [--global] [--target DIR]
 *                                 [--project DIR]
 *                                 [--target-agents zcode,opencode,claude-code]
 *                                 [--all-agents]
 */

const SKILL_NAMES = ['vibecanvas', 'vibecanvas-workflow-compose', 'vibecanvas-image-generate', 'vibecanvas-image-edit', 'vibecanvas-creative-review']

interface ServerDescriptor {
  /** Absolute path to the bundled MCP entry. */
  mcpJsPath: string
  /** Absolute path to the user project directory. */
  projectDir: string
  /** Absolute path to the unified config file. */
  configFile: string
}

interface AgentEmitter {
  /** Stable identifier used in --target-agents lists. */
  name: AgentName
  /** Path of the config file the emitter writes to. */
  configPath: (projectDir: string) => string
  /** Mutate the parsed config object to register the VibeCanvas MCP server. */
  register: (config: Record<string, unknown>, server: ServerDescriptor) => void
}

type AgentName = 'zcode' | 'opencode' | 'claude-code'

const EMITTERS: Record<AgentName, AgentEmitter> = {
  zcode: {
    name: 'zcode',
    configPath: (projectDir) => path.join(projectDir, '.zcode', 'config.json'),
    register: (config, server) => {
      const mcp = (config.mcp && typeof config.mcp === 'object' ? config.mcp : {}) as Record<string, unknown>
      const servers = (mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : {}) as Record<string, unknown>
      servers.vibecanvas = {
        type: 'stdio',
        command: 'node',
        args: [server.mcpJsPath],
        env: { VIBECANVAS_PROJECT_DIR: server.projectDir, VIBECANVAS_CONFIG_FILE: server.configFile }
      }
      mcp.servers = servers
      config.mcp = mcp
    }
  },
  opencode: {
    name: 'opencode',
    configPath: (projectDir) => path.join(projectDir, 'opencode.json'),
    register: (config, server) => {
      if (!config.$schema) config.$schema = 'https://opencode.ai/config.json'
      const mcp = (config.mcp && typeof config.mcp === 'object' ? config.mcp : {}) as Record<string, unknown>
      mcp.vibecanvas = {
        type: 'local',
        command: ['node', server.mcpJsPath],
        cwd: server.projectDir,
        enabled: true,
        environment: { VIBECANVAS_PROJECT_DIR: server.projectDir, VIBECANVAS_CONFIG_FILE: server.configFile }
      }
      config.mcp = mcp
    }
  },
  'claude-code': {
    name: 'claude-code',
    configPath: (projectDir) => path.join(projectDir, '.mcp.json'),
    register: (config, server) => {
      const mcpServers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>
      mcpServers.vibecanvas = {
        type: 'stdio',
        command: 'node',
        args: [server.mcpJsPath],
        env: { VIBECANVAS_PROJECT_DIR: server.projectDir, VIBECANVAS_CONFIG_FILE: server.configFile }
      }
      config.mcpServers = mcpServers
    }
  }
}

/**
 * Run the installer. Args mirror the CLI flags. Exported so future tooling can
 * invoke the installer programmatically; scripts run this function as the
 * module entry point.
 */
export async function runInstallSkills(argv: string[]): Promise<void> {
  const scope = argv.includes('--global') ? 'global' : 'project'
  const explicitTarget = valueAfter(argv, '--target')
  const projectDir = path.resolve(valueAfter(argv, '--project') || process.cwd())
  const source = path.resolve('skills')
  const skillsTarget = explicitTarget
    ? path.resolve(explicitTarget)
    : scope === 'global'
      ? path.join(os.homedir(), '.agents', 'skills')
      : path.join(projectDir, '.agents', 'skills')

  // Always install the skill Markdown bundles. They are agent-agnostic.
  await mkdir(skillsTarget, { recursive: true })
  for (const name of SKILL_NAMES) {
    await cp(path.join(source, name), path.join(skillsTarget, name), { recursive: true, force: true })
    console.log(`Installed skill ${name} -> ${path.join(skillsTarget, name)}`)
  }

  // Decide which agent configs to generate. Precedence:
  //   --all-agents > --target-agents a,b,c > legacy per-agent flags
  let requested: AgentName[]
  if (argv.includes('--all-agents')) {
    requested = ['zcode', 'opencode', 'claude-code']
  } else if (argv.includes('--target-agents')) {
    const list = valueAfter(argv, '--target-agents') || ''
    requested = list.split(',').map((item) => item.trim()).filter(Boolean) as AgentName[]
  } else {
    requested = []
    if (argv.includes('--write-zcode')) requested.push('zcode')
    if (argv.includes('--write-opencode')) requested.push('opencode')
    if (argv.includes('--write-claude-code')) requested.push('claude-code')
  }

  if (!requested.length) {
    console.log('\nNo agent targets specified. Skipping MCP config generation.')
    console.log('Use --target-agents zcode,opencode,claude-code or --all-agents to register the MCP server.')
    return
  }

  const server: ServerDescriptor = {
    mcpJsPath: path.resolve('dist/node/mcp.js'),
    projectDir,
    configFile: defaultConfigPath()
  }

  for (const name of requested) {
    const emitter = EMITTERS[name]
    if (!emitter) {
      console.warn(`Unknown agent target: ${name}. Skipping.`)
      continue
    }
    const configPath = emitter.configPath(projectDir)
    let config: Record<string, unknown> = {}
    try { config = JSON.parse(await readFile(configPath, 'utf8')) } catch { /* create new */ }
    emitter.register(config, server)
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
    console.log(`Wrote ${name} MCP config -> ${configPath}`)
  }
}

await runInstallSkills(process.argv.slice(2))

function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag)
  return index >= 0 ? values[index + 1] : undefined
}
