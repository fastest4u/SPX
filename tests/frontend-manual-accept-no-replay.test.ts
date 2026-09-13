import assert from 'node:assert/strict'

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const redirects: string[] = []
  const calls: Array<{ url: string; method: string }> = []
  const submitted = { bookingId: 123, teamId: 7, confirm: true as const }
  let scenario: 'manual401' | 'read401' | 'success' | 'transport' = 'manual401'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://dashboard.invalid', replace: (url: string) => redirects.push(url) } },
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    assert.equal(init?.credentials, 'include')
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    })
    // A successful refresh is available: the original bug follows this path
    // and dispatches accept-all a second time after the provider-style 401.
    if (url === '/api/refresh' && method === 'POST') return reply(200, { status: 'success', data: null })
    if (url === '/api/bidding/accept-all' && method === 'POST') {
      assert.deepEqual(JSON.parse(String(init?.body)), submitted)
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json')
      if (scenario === 'transport') throw new TypeError('synthetic response lost after dispatch')
      if (scenario === 'manual401' && calls.filter(call => call.url === url).length === 1) {
        return reply(401, { status: 'error', error_code: 'PROVIDER_UNAUTHORIZED', message: 'provider response after dispatch' })
      }
      return reply(200, { status: 'success', data: { bookingId: 123, acceptedCount: 0, verifiedAcceptedCount: 0, verificationStatus: 'indeterminate' } })
    }
    if (url === '/api/rules' && method === 'GET' && scenario === 'read401') {
      return calls.filter(call => call.url === url).length === 1
        ? reply(401, { status: 'error', error_code: 'UNAUTHORIZED', message: 'expired' })
        : reply(200, { status: 'success', data: [] })
    }
    throw new Error(`unexpected synthetic request: ${method} ${url}`)
  }
  try {
    const { biddingApi, rulesApi, AuthError } = await import('../src/frontend/lib/api.js')
    const outcome = await biddingApi.acceptAll(submitted).then(
      value => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    )
    assert.equal(calls.filter(call => call.url === '/api/bidding/accept-all').length, 1,
      `manual POST must not replay after provider 401 even when refresh would succeed: ${JSON.stringify(calls)}`)
    assert.ok(outcome.error instanceof AuthError)
    assert.match(outcome.error.message, /PROVIDER_UNAUTHORIZED: provider response after dispatch/)
    assert.deepEqual(calls, [{ url: '/api/bidding/accept-all', method: 'POST' }])
    assert.deepEqual(redirects, [], 'ambiguous provider 401 must leave the result panel available')

    calls.length = 0
    scenario = 'read401'
    assert.deepEqual(await rulesApi.list(), [])
    assert.deepEqual(calls, [
      { url: '/api/rules', method: 'GET' },
      { url: '/api/refresh', method: 'POST' },
      { url: '/api/rules', method: 'GET' },
    ], 'ordinary reads keep one refresh and retry')

    calls.length = 0
    scenario = 'success'
    assert.equal((await biddingApi.acceptAll(submitted)).verificationStatus, 'indeterminate')
    assert.equal(calls.length, 1)

    calls.length = 0
    scenario = 'transport'
    await assert.rejects(biddingApi.acceptAll(submitted), /synthetic response lost after dispatch/)
    assert.deepEqual(calls, [{ url: '/api/bidding/accept-all', method: 'POST' }])
    console.log('frontend-manual-accept-no-replay: exported manual client stays single-dispatch; read refresh preserved')
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
