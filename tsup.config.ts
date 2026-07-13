import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    server: 'src/server/index.ts',
    mcp: 'src/mcp/index.ts',
    cli: 'src/server/cli.ts'
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist/node',
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  external: ['sharp', 'node:sqlite']
})
