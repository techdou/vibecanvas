#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVibeCanvasApp } from './app.js'
import { getRuntimeConfig } from '../core/config.js'
import { WorkspaceStorage } from '../core/storage.js'
import { validateGraph } from '../core/graph.js'
import { startMcpServer } from '../mcp/index.js'

const [command = 'serve', ...args] = process.argv.slice(2)
const flags = parseFlags(args)

if (['--help', '-h'].includes(command) || args.includes('--help') || args.includes('-h')) {
  printHelp()
  process.exit(0)
}
if (['--version', '-V'].includes(command)) {
  console.log(readVersion())
  process.exit(0)
}

switch (command) {
  case 'serve':
  case 'start': {
    const config = await getRuntimeConfig()
    if (flags.project) config.projectDir = path.resolve(flags.project)
    if (flags.host) config.host = flags.host
    if (flags.port) config.port = Number(flags.port)
    const runtime = await createVibeCanvasApp(config)
    runtime.server.listen(config.port, config.host, () => {
      console.log(`VibeCanvas Web: http://${config.host}:${config.port}`)
      console.log(`Workspace: ${config.projectDir}`)
    })
    break
  }
  case 'mcp': {
    await startMcpServer()
    break
  }
  case 'dev': {
    // Run web + mcp + vite in parallel for local development. Mirrors `npm run dev`
    // but goes through the unified CLI so users have one entry point.
    const root = findRepoRoot()
    const children: Array<ReturnType<typeof spawn>> = []
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    const stop = () => { for (const child of children) if (!child.killed) child.kill() }
    for (const signal of signals) process.on(signal, () => { stop(); process.exit(0) })
    children.push(spawn('node', ['--import', 'tsx', path.join(root, 'src/server/index.ts')], { stdio: 'inherit', env: process.env }))
    children.push(spawn('node', ['--import', 'tsx', path.join(root, 'src/mcp/index.ts')], { stdio: 'inherit', env: process.env }))
    children.push(spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5173'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }))
    break
  }
  case 'doctor': {
    // Delegate to scripts/doctor.ts via tsx so the script owns its own process
    // lifecycle and exit code. Avoids bundling script code into the CLI build.
    runScript('doctor.ts', args.filter((arg) => arg !== '--project'))
    break
  }
  case 'install-skills': {
    runScript('install-skills.ts', args)
    break
  }
  case 'validate': {
    const storage = new WorkspaceStorage(flags.project || process.cwd())
    await storage.init()
    const result = validateGraph(await storage.loadGraph())
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.valid ? 0 : 1
    storage.close()
    break
  }
  case 'open': {
    const config = await getRuntimeConfig()
    const url = `http://${config.host}:${config.port}`
    const commandName = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(commandName, commandArgs, { detached: true, stdio: 'ignore' })
    child.unref()
    console.log(url)
    break
  }
  default:
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exitCode = 1
}

function parseFlags(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { result[key] = next; i += 1 } else result[key] = 'true'
  }
  return result
}

function printHelp(): void {
  console.log(`VibeCanvas ${readVersion()}

Usage: vibecanvas <command> [options]

Commands:
  serve [--project DIR] [--host H] [--port N]   Start the Web process (canvas + REST API + WebSocket).
  mcp                                            Start the MCP stdio server (21 tools for external agents).
  dev                                            Start Web + MCP + Vite watch in parallel (local dev).
  doctor [--probe-provider]                      Run environment health checks.
  install-skills [--target AGENTS]               Install skills and generate per-agent MCP config.
  validate [--project DIR]                       Validate the current design graph and print the result.
  open                                           Open the running Web UI in the default browser.

Global options:
  --help, -h                                     Show this help.
  --version, -V                                  Print the version and exit.`)
}

function readVersion(): string {
  return process.env.npm_package_version || '2.0.0'
}

function findRepoRoot(): string {
  // cli.ts is bundled into dist/node/cli.js. dev mode runs from src/ via tsx.
  // Walk up to find the directory that contains package.json.
  let current = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i += 1) {
    if (current === path.dirname(current)) break
    current = path.dirname(current)
  }
  return process.cwd()
}

function runScript(name: string, scriptArgs: string[]): void {
  // In dev (tsx) we run scripts/*.ts directly; in the bundled dist build we
  // fall back to the corresponding npm script. The npm script also runs tsx,
  // so behavior is equivalent.
  const root = findRepoRoot()
  const scriptPath = path.join(root, 'scripts', name)
  const result = spawnSync('npx', ['tsx', scriptPath, ...scriptArgs], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
  if (result.status != null) process.exitCode = result.status
  else if (result.signal) process.exitCode = 130
}
