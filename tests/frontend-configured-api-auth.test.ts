import assert from 'node:assert/strict'
import {
  createDashboardFrontendRuntimeConfig,
  dashboardFrontendRuntimeConfig,
} from '../src/frontend/lib/runtime-config.js'

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalConfig = { ...dashboardFrontendRuntimeConfig }
  const redirects: string[] = []
  const calls: Array<{ url: string; method: string }> = []
  const responses: Array<{ status: number; data?: unknown }> = []
  // Supply the configuration boundary before the API module creates its clients.
  // No Vite server or real endpoint is needed to exercise the exported clients.
  Object.assign(dashboardFrontendRuntimeConfig, createDashboardFrontendRuntimeConfig({
    VITE_DASHBOARD_API_BASE_URL: 'https://web-api.example/gateway/api/',
    VITE_DASHBOARD_READ_MODEL_BASE_URL: 'https://read-model.example/',
  }))
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://dashboard.example', replace: (url: string) => redirects.push(url) } },
  })
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    assert.equal(init?.credentials, 'include')
    const next = responses.shift()
    assert.ok(next, `unexpected fetch: ${String(input)}`)
    return new Response(JSON.stringify(next.status === 401
      ? { status: 'error', error_code: 'UNAUTHORIZED', message: 'expired' }
      : { status: 'success', data: next.data ?? null }), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const { authApi, rulesApi, metricsApi, providerAuthApi, AuthError, DashboardAuthExpiredError } =
      await import('../src/frontend/lib/api.js')

    for (const [operation, path, method] of [
      [() => authApi.login('fixture', 'synthetic-password'), '/login', 'POST'],
      [() => authApi.me(), '/me', 'GET'],
      [() => authApi.refresh(), '/refresh', 'POST'],
    ] as const) {
      calls.length = 0
      responses.push({ status: 401 })
      await assert.rejects(operation, AuthError)
      assert.deepEqual(calls, [{ url: `https://web-api.example/gateway/api${path}`, method }],
        'configured auth endpoints must fail without a recursive refresh or redirect')
      assert.deepEqual(redirects, [])
    }

    calls.length = 0
    responses.push({ status: 401 }, { status: 200 }, { status: 200, data: [] })
    assert.deepEqual(await rulesApi.list(), [])
    assert.deepEqual(calls, [
      { url: 'https://web-api.example/gateway/api/rules', method: 'GET' },
      { url: 'https://web-api.example/gateway/api/refresh', method: 'POST' },
      { url: 'https://web-api.example/gateway/api/rules', method: 'GET' },
    ], 'ordinary configured API requests refresh once and retry once')

    calls.length = 0
    responses.push({ status: 200, data: { uptime: 123 } }, { status: 200, data: [] })
    assert.deepEqual(await metricsApi.snapshot(), { uptime: 123 })
    assert.deepEqual(await metricsApi.history(5), [])
    assert.deepEqual(calls, [
      { url: 'https://read-model.example/metrics', method: 'GET' },
      { url: 'https://read-model.example/metrics/history?limit=5', method: 'GET' },
    ], 'the default exported metrics client must consume runtime configuration')

    calls.length = 0
    responses.push({ status: 401 }, { status: 200 })
    await assert.rejects(providerAuthApi.connect({
      email: 'operator@example.test', password: 'synthetic-password',
    }, 7), DashboardAuthExpiredError)
    assert.deepEqual(calls, [
      { url: 'https://web-api.example/gateway/api/teams/7/provider-auth', method: 'PUT' },
      { url: 'https://web-api.example/gateway/api/refresh', method: 'POST' },
    ], 'configuring the API base must not replay provider credentials after refreshing')

    calls.length = 0
    responses.push({ status: 200, data: { paused: true } }, { status: 200, data: { paused: false } })
    await metricsApi.pause()
    await metricsApi.resume()
    assert.deepEqual(calls, [
      { url: '/system/pause', method: 'POST' },
      { url: '/system/resume', method: 'POST' },
    ], 'metrics configuration must not reroute control mutations to the read model')

    calls.length = 0
    responses.push({ status: 401 }, { status: 200 }, { status: 401 })
    await assert.rejects(rulesApi.list(), AuthError)
    assert.deepEqual(calls, [
      { url: 'https://web-api.example/gateway/api/rules', method: 'GET' },
      { url: 'https://web-api.example/gateway/api/refresh', method: 'POST' },
      { url: 'https://web-api.example/gateway/api/rules', method: 'GET' },
    ], 'a second 401 must not restart the refresh loop')
    assert.deepEqual(redirects, ['/login'])
    assert.equal(responses.length, 0)
    console.log('frontend-configured-api-auth: configured clients and auth safeguards passed')
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(dashboardFrontendRuntimeConfig, originalConfig)
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
