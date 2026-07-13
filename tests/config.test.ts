import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigStore, defaultConfigFile, redactConfig } from '../src/core/config.js'

describe('unified configuration', () => {
  it('stores one provider configuration for Web, CLI, and MCP with secret-safe permissions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibecanvas-config-'))
    const file = path.join(dir, 'config.json')
    const store = new ConfigStore(file)
    const config = defaultConfigFile()
    const profile = config.providers[config.activeProviderId]
    profile.apiKey = 'secret-token'
    profile.headers = { 'x-channel': 'abc', Authorization: 'Bearer second-secret' }
    profile.downloadHeaders = { 'x-download-token': 'download-secret' }
    await store.save(config)
    const loaded = await store.load()
    expect(loaded.providers[loaded.activeProviderId].apiKey).toBe('secret-token')
    const redacted = redactConfig(loaded)
    expect(redacted.providers[loaded.activeProviderId].apiKey).toBe('********')
    expect(redacted.providers[loaded.activeProviderId].headers.Authorization).toBe('********')
    expect(redacted.providers[loaded.activeProviderId].headers['x-channel']).toBe('abc')
    expect(JSON.parse(await readFile(file, 'utf8')).activeProviderId).toBe(config.activeProviderId)
  })

  it('merges partial provider capabilities and cost tables with defaults', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibecanvas-config-merge-'))
    const file = path.join(dir, 'config.json')
    const store = new ConfigStore(file)
    await store.save({
      version: 1,
      activeProviderId: 'relay',
      providers: {
        relay: {
          ...defaultConfigFile().providers['default-image2'], id: 'relay', label: 'Relay', capabilities: { ...defaultConfigFile().providers['default-image2'].capabilities, maskEdit: false }, costs: { ...defaultConfigFile().providers['default-image2'].costs, high: 0.12 }
        }
      },
      openCode: { baseUrl: 'http://127.0.0.1:4096' },
      runtime: { host: '127.0.0.1', port: 43120, concurrency: 2, leaseSeconds: 30 }
    })
    const loaded = await store.load()
    expect(loaded.providers.relay.capabilities.maskEdit).toBe(false)
    expect(loaded.providers.relay.capabilities.textToImage).toBe(true)
    expect(loaded.providers.relay.costs.high).toBe(0.12)
  })
})
