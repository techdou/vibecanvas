import { createVibeCanvasApp } from './app.js'

const runtime = await createVibeCanvasApp()
runtime.server.listen(runtime.config.port, runtime.config.host, () => {
  console.log(`VibeCanvas server: http://${runtime.config.host}:${runtime.config.port}`)
  console.log(`Project workspace: ${runtime.storage.projectDir}`)
})
