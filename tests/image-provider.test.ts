import { createServer } from 'node:http'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { Image2Provider } from '../src/core/image-provider.js'
import { makeProfile, tempWorkspace } from './helpers.js'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return address.port
}

function png(width = 1024, height = 1024, background = '#b66f48') {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()
}

describe('Image2Provider', () => {
  it('accepts Base64, sends custom headers, and records cost metadata', async () => {
    const image = await png()
    let header = ''
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        header = String(req.headers['x-channel-id'] || '')
        let body = ''
        for await (const chunk of req) body += chunk
        expect(JSON.parse(body).model).toBe('image-2-test')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
        return
      }
      res.statusCode = 404; res.end()
    })
    const port = await listen(server)
    const { storage } = await tempWorkspace('vibecanvas-provider-')
    const provider = new Image2Provider(makeProfile({
      apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'image-2-test', maxRetries: 0,
      headers: { 'x-channel-id': 'channel-7' }, costs: { low: 0.01, medium: 0.02, high: 0.05, auto: 0.03, editMultiplier: 1.5 }
    }), storage)
    const result = await provider.generate({ prompt: 'test prompt', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-test', nodeId: 'node-test' })
    expect(header).toBe('channel-7')
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].width).toBe(1024)
    expect(result.artifacts[0].metadata?.operation).toBe('generate')
    expect(result.estimatedCostUsd).toBe(0.05)
    storage.close()
  })

  it('accepts URL responses, applies download headers, and retries transient failures', async () => {
    const image = await png()
    let attempts = 0
    let downloadHeader = ''
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        attempts += 1
        if (attempts === 1) { res.statusCode = 500; res.end(JSON.stringify({ error: 'temporary' })); return }
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('No port')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${address.port}/image.png` }] }))
        return
      }
      if (req.url === '/image.png') {
        downloadHeader = String(req.headers['x-download-token'] || '')
        res.setHeader('content-type', 'image/png'); res.end(image); return
      }
      res.statusCode = 404; res.end()
    })
    const port = await listen(server)
    const { storage } = await tempWorkspace('vibecanvas-provider-url-')
    const provider = new Image2Provider(makeProfile({
      apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 1,
      allowPrivateImageUrls: true, downloadHeaders: { 'x-download-token': 'download-secret' }
    }), storage)
    const result = await provider.generate({ prompt: 'url response', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-url', nodeId: 'node-url' })
    expect(attempts).toBe(2)
    expect(downloadHeader).toBe('download-secret')
    expect(result.artifacts[0].width).toBe(1024)
    storage.close()
  })

  it('blocks private URL downloads unless explicitly allowed', async () => {
    const server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('No port')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${address.port}/image.png` }] }))
        return
      }
      res.statusCode = 404; res.end()
    })
    const port = await listen(server)
    const { storage } = await tempWorkspace('vibecanvas-provider-ssrf-')
    const provider = new Image2Provider(makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 }), storage)
    await expect(provider.generate({ prompt: 'blocked', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run', nodeId: 'node' }))
      .rejects.toThrow(/Blocked private or local image URL/)
    storage.close()
  })

  it('submits source, references, and normalized alpha mask as multipart PNG files', async () => {
    const output = await png()
    let multipartBody = ''
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/edits') {
        for await (const chunk of req) multipartBody += Buffer.from(chunk).toString('latin1')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }))
        return
      }
      res.statusCode = 404; res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-provider-edit-')
    const sourcePath = path.join(dir, 'source.jpg')
    const referencePath = path.join(dir, 'reference.webp')
    const maskPath = path.join(dir, 'mask.png')
    await sharp(await png()).jpeg().toFile(sourcePath)
    await sharp(await png()).webp().toFile(referencePath)
    const alpha = Buffer.alloc(1024 * 1024, 255)
    alpha.fill(0, 0, 100 * 1024)
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).joinChannel(alpha, { raw: { width: 1024, height: 1024, channels: 1 } }).png().toFile(maskPath).catch(async () => {
      await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } }).png().toFile(maskPath)
    })
    const source = await storage.registerArtifact({ filePath: sourcePath })
    const reference = await storage.registerArtifact({ filePath: referencePath })
    const mask = await storage.registerArtifact({ filePath: maskPath, kind: 'mask' })
    const provider = new Image2Provider(makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 }), storage)
    const result = await provider.edit({ prompt: 'edit request', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-edit', nodeId: 'node-edit', source, references: [reference], mask })
    expect(result.artifacts).toHaveLength(1)
    expect((multipartBody.match(/name="image\[\]"/g) || []).length).toBe(2)
    expect(multipartBody).toContain('name="mask"')
    expect(multipartBody).toContain('filename="mask.png"')
    storage.close()
  })

  it('rejects masks with mismatched dimensions or no alpha channel', async () => {
    const { dir, storage } = await tempWorkspace('vibecanvas-provider-mask-')
    const sourcePath = path.join(dir, 'source.png')
    const maskPath = path.join(dir, 'bad-mask.jpg')
    await sharp(await png()).toFile(sourcePath)
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ffffff' } }).jpeg().toFile(maskPath)
    const source = await storage.registerArtifact({ filePath: sourcePath })
    const mask = await storage.registerArtifact({ filePath: maskPath, kind: 'mask' })
    const provider = new Image2Provider(makeProfile({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1/v1', maxRetries: 0 }), storage)
    await expect(provider.edit({ prompt: 'bad mask', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-mask', nodeId: 'node-mask', source, mask }))
      .rejects.toThrow(/Mask dimensions must .*match|alpha channel/)
    storage.close()
  })

  it('aborts an in-flight API request without registering an artifact', async () => {
    const image = await png()
    const server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 800))
        if (!res.destroyed) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] })) }
        return
      }
      res.statusCode = 404; res.end()
    })
    const port = await listen(server)
    const { storage } = await tempWorkspace('vibecanvas-provider-abort-')
    const provider = new Image2Provider(makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 }), storage)
    const controller = new AbortController()
    const promise = provider.generate({ prompt: 'abort', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-abort', nodeId: 'node-abort', signal: controller.signal })
    setTimeout(() => controller.abort('test cancellation'), 60)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(await storage.listArtifacts()).toHaveLength(0)
    storage.close()
  })
  it('rejects embedded URL credentials and oversized edit inputs before network access', async () => {
    const output = await png()
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/images/generations') {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('No port')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ url: `http://user:secret@127.0.0.1:${address.port}/image.png` }] }))
        return
      }
      if (req.url === '/image.png') { res.setHeader('content-type', 'image/png'); res.end(output); return }
      res.statusCode = 404; res.end()
    })
    const port = await listen(server)
    const { dir, storage } = await tempWorkspace('vibecanvas-provider-safety-')
    const provider = new Image2Provider(makeProfile({ apiKey: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0, allowPrivateImageUrls: true }), storage)
    await expect(provider.generate({ prompt: 'credential URL', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-url-creds', nodeId: 'node-url-creds' }))
      .rejects.toThrow(/embedded credentials/)

    const sourcePath = path.join(dir, 'source.png')
    await sharp(await png()).toFile(sourcePath)
    const source = await storage.registerArtifact({ filePath: sourcePath })
    source.sizeBytes = 51 * 1024 * 1024
    await expect(provider.edit({ prompt: 'oversized', width: 1024, height: 1024, quality: 'high', candidateCount: 1, runId: 'run-large', nodeId: 'node-large', source }))
      .rejects.toThrow(/50 MB limit/)
    storage.close()
  })

})
