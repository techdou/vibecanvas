import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:43120',
      '/assets': 'http://127.0.0.1:43120',
      '/ws': {
        target: 'ws://127.0.0.1:43120',
        ws: true
      }
    }
  }
})
