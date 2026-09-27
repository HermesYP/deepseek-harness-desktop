// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

function responseFor(request: { rpcId: string; method: string }) {
  const values: Record<string, unknown> = {
    'settings/describe': { namespaces: [{ ns: 'provider-settings', value: { routes: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } } }] },
    'llm/listConfigurableProviders': [{ provider: 'deepseek', settingsNs: 'provider-settings', settingsPath: ['routes', 'deepseek'] }],
    'credentials/describe': { DEEPSEEK_API_KEY: { configured: true, source: 'environment', writable: false } },
  }
  return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: values[request.method] } })
}

describe('dshOnboarding Host credential discovery', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses existing authenticated Host RPC routes and never asks the Rust keyring', async () => {
    const requests: Array<{ method: string; args: Record<string, unknown> }> = []
    vi.stubGlobal('__DSH_TRANSPORT__', { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:3085' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        rpcId: string; method: string; payload: { args: Record<string, unknown> }
      }
      requests.push({ method: body.method, args: body.payload.args })
      return responseFor(body)
    }))
    const { desktop } = await import('../index.ts')
    const { createOnboardingBridge } = await import('../markers.ts')

    await expect(createOnboardingBridge(desktop).hasApiKey()).resolves.toBe(true)
    expect(requests.map(request => request.method)).toEqual([
      'settings/describe', 'llm/listConfigurableProviders', 'credentials/describe',
    ])
    expect(requests[2]?.args).toEqual({ refs: ['DEEPSEEK_API_KEY'] })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      new URL('/api/credentials/describe', 'http://127.0.0.1:3085'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
  })
})
