import assert from 'node:assert/strict'

async function main(): Promise<void> {
  const {
    createDashboardFrontendRuntimeConfig,
    resolveDashboardRuntimeUrl,
  } = await import('../src/frontend/lib/runtime-config.js')

  const defaults = createDashboardFrontendRuntimeConfig({})
  assert.equal(defaults.apiBaseUrl, '/api')
  assert.equal(defaults.readModelBaseUrl, '')
  assert.equal(defaults.realtimeBaseUrl, '')
  assert.equal(defaults.ssePath, '/events')
  assert.equal(defaults.metricsPath, '/metrics')
  assert.equal(defaults.metricsHistoryPath, '/metrics/history')
  assert.equal(defaults.runtimeStatusPath, '/api/runtime/status')
  assert.deepEqual(defaults.reconnect, { initialMs: 5000, maxMs: 60000, maxRetries: 10 })
  assert.equal(defaults.fallbackPollMs, 60000)
  assert.equal(defaults.withCredentials, true)
  assert.equal(defaults.envelopeVersion, 1)

  const configured = createDashboardFrontendRuntimeConfig({
    VITE_DASHBOARD_READ_MODEL_BASE_URL: ' https://read-model.example/api/ ',
    VITE_DASHBOARD_REALTIME_BASE_URL: ' https://realtime.example/ ',
    VITE_DASHBOARD_METRICS_PATH: ' metrics ',
    VITE_DASHBOARD_METRICS_HISTORY_PATH: ' /metrics/history/ ',
    VITE_DASHBOARD_FALLBACK_POLL_MS: ' 120000 ',
  })
  assert.equal(configured.readModelBaseUrl, 'https://read-model.example/api/')
  assert.equal(configured.realtimeBaseUrl, 'https://realtime.example/')
  assert.equal(configured.metricsPath, 'metrics')
  assert.equal(configured.metricsHistoryPath, '/metrics/history/')
  assert.equal(configured.fallbackPollMs, 120000)
  assert.equal(
    resolveDashboardRuntimeUrl(configured.readModelBaseUrl, configured.metricsPath),
    'https://read-model.example/api/metrics',
  )
  assert.equal(
    resolveDashboardRuntimeUrl(configured.realtimeBaseUrl, '/events'),
    'https://realtime.example/events',
  )
  assert.equal(resolveDashboardRuntimeUrl('', 'metrics'), '/metrics')
  assert.equal(
    resolveDashboardRuntimeUrl('https://ignored.example', 'https://absolute.example/metrics'),
    'https://absolute.example/metrics',
  )

  const relativeApiBase = createDashboardFrontendRuntimeConfig({
    VITE_DASHBOARD_API_BASE_URL: ' /gateway/api/ ',
  })
  assert.equal(relativeApiBase.apiBaseUrl, '/gateway/api')
  assert.equal(
    resolveDashboardRuntimeUrl(relativeApiBase.apiBaseUrl, '/refresh'),
    '/gateway/api/refresh',
  )

  const absoluteApiBase = createDashboardFrontendRuntimeConfig({
    VITE_DASHBOARD_API_BASE_URL: ' https://web-api.example/gateway/api/ ',
  })
  assert.equal(absoluteApiBase.apiBaseUrl, 'https://web-api.example/gateway/api')
  assert.equal(
    resolveDashboardRuntimeUrl(absoluteApiBase.apiBaseUrl, '/login'),
    'https://web-api.example/gateway/api/login',
  )

  const rootApiBase = createDashboardFrontendRuntimeConfig({
    VITE_DASHBOARD_API_BASE_URL: '/',
  })
  assert.equal(rootApiBase.apiBaseUrl, '')
  assert.equal(
    resolveDashboardRuntimeUrl(rootApiBase.apiBaseUrl, '/login'),
    '/login',
  )

  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return new Response(JSON.stringify({ status: 'success', data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) satisfies typeof fetch

  const { createAuthExemptPaths, createMetricsApi } = await import('../src/frontend/lib/api.js')
  assert.deepEqual(createAuthExemptPaths(relativeApiBase.apiBaseUrl), [
    '/gateway/api/login',
    '/gateway/api/me',
    '/gateway/api/refresh',
  ])
  assert.deepEqual(createAuthExemptPaths(absoluteApiBase.apiBaseUrl), [
    '/gateway/api/login',
    '/gateway/api/me',
    '/gateway/api/refresh',
  ])
  assert.deepEqual(createAuthExemptPaths(rootApiBase.apiBaseUrl), [
    '/login',
    '/me',
    '/refresh',
  ])
  const metricsApi = createMetricsApi(configured)
  await metricsApi.snapshot()
  await metricsApi.history(5)

  assert.deepEqual(calls, [
    {
      url: 'https://read-model.example/api/metrics',
      init: { credentials: 'include', headers: new Headers() },
    },
    {
      url: 'https://read-model.example/api/metrics/history/?limit=5',
      init: { credentials: 'include', headers: new Headers() },
    },
  ])

  console.log('frontend-runtime-config: all assertions passed')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
