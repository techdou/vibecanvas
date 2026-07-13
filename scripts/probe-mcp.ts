import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const projectDir = await mkdtemp(path.join(os.tmpdir(), 'vibecanvas-mcp-'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/node/mcp.js')],
  env: { ...process.env, VIBECANVAS_PROJECT_DIR: projectDir }
})
const client = new Client({ name: 'vibecanvas-probe', version: '2.0.0' })
await client.connect(transport)
const tools = await client.listTools()
if (!tools.tools.some((tool) => tool.name === 'get_workspace_context')) throw new Error('Expected MCP tool was not registered.')
const context = await client.callTool({ name: 'get_workspace_context', arguments: {} })
console.log(`MCP probe passed: ${tools.tools.length} tools; context=${Boolean(context.structuredContent)}`)
await client.close()
