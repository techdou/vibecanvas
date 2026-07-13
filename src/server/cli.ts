#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createVibeCanvasApp } from './app.js'
import { getRuntimeConfig } from '../core/config.js'
import { WorkspaceStorage } from '../core/storage.js'
import { validateGraph } from '../core/graph.js'

const [command = 'start', ...args] = process.argv.slice(2)

if (command === 'start') {
  const config = await getRuntimeConfig()
  const projectArg = valueAfter(args, '--project')
  if (projectArg) config.projectDir = path.resolve(projectArg)
  const runtime = await createVibeCanvasApp(config)
  runtime.server.listen(config.port, config.host, () => console.log(`VibeCanvas: http://${config.host}:${config.port}`))
} else if (command === 'validate') {
  const storage = new WorkspaceStorage(valueAfter(args, '--project') || process.cwd())
  const result = validateGraph(await storage.loadGraph())
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.valid ? 0 : 1
} else if (command === 'open') {
  const config = await getRuntimeConfig()
  const url = `http://${config.host}:${config.port}`
  const commandName = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(commandName, commandArgs, { detached: true, stdio: 'ignore' })
  child.unref()
  console.log(url)
} else {
  console.error(`Unknown command: ${command}\nCommands: start, validate, open`)
  process.exitCode = 1
}

function valueAfter(args: string[], key: string): string | undefined {
  const index = args.indexOf(key)
  return index >= 0 ? args[index + 1] : undefined
}
