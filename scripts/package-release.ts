import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { ZipArchive, type ArchiverError } from 'archiver'

const version = process.env.npm_package_version || '2.0.0'
const projectDir = process.cwd()
const parentDir = path.dirname(projectDir)
const projectName = path.basename(projectDir)
const output = path.join(parentDir, `vibecanvas-v${version}.zip`)

await rm(output, { force: true })
await new Promise<void>((resolve, reject) => {
  const stream = createWriteStream(output)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  stream.on('close', resolve)
  stream.on('error', reject)
  archive.on('warning', (error: ArchiverError) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') console.warn(error.message)
    else reject(error)
  })
  archive.on('error', reject)
  archive.pipe(stream)
  archive.glob('**/*', {
    cwd: projectDir,
    dot: true,
    ignore: [
      '.git/**', 'node_modules/**', '.vibecanvas/**', 'demo-workspace/**',
      'coverage/**', '*.zip', '.env', '*.log', '.DS_Store'
    ]
  }, { prefix: projectName })
  void archive.finalize()
})

console.log(output)
