import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLLMProvider, FallbackProvider, OpenAIChatProvider, OpenCodeSessionProvider
} from '../src/core/llm-provider.js'
import type { LLMProfile } from '../src/core/types.js'

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

describe('LLM provider factory', () => {
  it('falls back to FallbackProvider when the openai-chat profile is missing required fields', () => {
    expect(createLLMProvider({ provider: 'openai-chat' } as LLMProfile)).toBeInstanceOf(FallbackProvider)
    expect(createLLMProvider({ provider: 'openai-chat', baseUrl: 'http://x', apiKey: 'k' })).toBeInstanceOf(FallbackProvider)
  })

  it('falls back when the opencode-session profile lacks baseUrl or sessionId', () => {
    expect(createLLMProvider({ provider: 'opencode-session', baseUrl: 'http://x' })).toBeInstanceOf(FallbackProvider)
    expect(createLLMProvider({ provider: 'opencode-session', sessionId: 's' })).toBeInstanceOf(FallbackProvider)
  })

  it('builds the right concrete provider when the profile is complete', () => {
    expect(createLLMProvider({ provider: 'fallback' })).toBeInstanceOf(FallbackProvider)
    expect(createLLMProvider({
      provider: 'openai-chat', baseUrl: 'http://x', apiKey: 'k', model: 'm'
    })).toBeInstanceOf(OpenAIChatProvider)
    expect(createLLMProvider({
      provider: 'opencode-session', baseUrl: 'http://x', sessionId: 's'
    })).toBeInstanceOf(OpenCodeSessionProvider)
  })
})

describe('OpenAIChatProvider', () => {
  it('parses structured JSON from a chat completion response, tolerating code fences', async () => {
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/chat/completions') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          choices: [{ message: { content: '```json\n{"answer": 42}\n```' } }]
        }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const provider = new OpenAIChatProvider({
      provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm'
    })
    const result = await provider.generateStructured({
      prompt: 'return an answer',
      schema: { type: 'object', properties: { answer: { type: 'number' } } }
    })
    expect(result.structured).toEqual({ answer: 42 })
  })

  it('includes image_url parts when images are attached', async () => {
    let captured: { messages: Array<{ content: unknown }> } | undefined
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/chat/completions') {
        let body = ''
        for await (const chunk of req) body += chunk
        captured = JSON.parse(body)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const port = await listen(server)
    const provider = new OpenAIChatProvider({
      provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'vision'
    })
    await provider.generateStructured({
      prompt: 'describe this image',
      images: [{ mime: 'image/jpeg', base64: 'AAAA' }],
      schema: { type: 'object' }
    })
    const userMessage = captured!.messages.find((message) => Array.isArray(message.content))
    expect(userMessage).toBeDefined()
    const parts = userMessage!.content as Array<{ type: string }>
    expect(parts.find((part) => part.type === 'text')).toBeDefined()
    expect(parts.find((part) => part.type === 'image_url')).toBeDefined()
  })

  it('throws on a non-200 response without retrying when retries are zero', async () => {
    const server = createServer((_req, res) => { res.statusCode = 500; res.end('boom') })
    const port = await listen(server)
    const provider = new OpenAIChatProvider({
      provider: 'openai-chat', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', maxRetries: 0
    })
    await expect(provider.generateStructured({ prompt: 'x', schema: {} })).rejects.toThrow(/500/)
  })
})

describe('FallbackProvider', () => {
  it('returns an empty structured payload so callers can substitute local heuristics', async () => {
    const provider = new FallbackProvider()
    const result = await provider.generateStructured({ prompt: 'x', schema: {} })
    expect(result.structured).toEqual({})
    expect((result.raw as { fallback: boolean }).fallback).toBe(true)
  })
})
