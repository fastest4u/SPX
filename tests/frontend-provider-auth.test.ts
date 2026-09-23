import assert from 'node:assert/strict'

import {
  calculateProviderAuthCooldown,
  getProviderAuthErrorCopy,
  shouldHideProviderAuthPanel,
} from '../src/frontend/components/ProviderAuthPanel.tsx'
import {
  ProviderAuthRequestError,
  DashboardAuthExpiredError,
  providerAuthApi,
} from '../src/frontend/lib/api.ts'

const originalFetch = globalThis.fetch
const requests: Array<{ url: string; init?: RequestInit }> = []

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    teamId: 7,
    email: 'operator@example.test',
    hasPassword: true,
    status: 'connected',
    lastLoginAt: '2026-09-11T10:00:00.000Z',
    expiresAt: '2026-09-11T11:00:00.000Z',
    errorCode: null,
    retryAt: null,
    ...overrides,
  }
}

async function run() {
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init })
  return new Response(JSON.stringify({ status: 'success', data: statusFixture() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

await providerAuthApi.get()
await providerAuthApi.get(7)
await providerAuthApi.connect({ email: ' operator@example.test ', password: 'not-a-real-password' })
await providerAuthApi.connect({ email: 'admin@example.test', password: 'not-a-real-password' }, 7)
await providerAuthApi.reconnect()
await providerAuthApi.reconnect(7)

assert.deepEqual(
  requests.map((request) => ({ url: request.url, method: request.init?.method })),
  [
    { url: '/api/team/provider-auth', method: undefined },
    { url: '/api/teams/7/provider-auth', method: undefined },
    { url: '/api/team/provider-auth', method: 'PUT' },
    { url: '/api/teams/7/provider-auth', method: 'PUT' },
    { url: '/api/team/provider-auth/reconnect', method: 'POST' },
    { url: '/api/teams/7/provider-auth/reconnect', method: 'POST' },
  ],
  'provider-auth URLs must select the own-team scope unless an admin explicitly supplies a team id',
)

const ownConnect = JSON.parse(String(requests[2].init?.body))
assert.deepEqual(ownConnect, { email: 'operator@example.test', password: 'not-a-real-password' })
assert.equal(requests[2].url.includes('password'), false, 'password must not enter a URL or query key')
assert.equal(new URL(requests[2].url, 'http://fixture.test').searchParams.size, 0, 'credential requests do not use query keys')
assert.equal(requests[2].init?.credentials, 'include')

requests.length = 0
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init })
  return new Response(JSON.stringify({
    status: 'error',
    error_code: 'PROVIDER_AUTH_RATE_LIMITED',
    message: 'safe backend text only',
    details: { retryAfterMs: 4_000 },
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '4' },
  })
}

await assert.rejects(
  providerAuthApi.connect({ email: 'operator@example.test', password: 'not-a-real-password' }),
  (error: unknown) => {
    assert.ok(error instanceof ProviderAuthRequestError)
    assert.equal(error.code, 'PROVIDER_AUTH_RATE_LIMITED')
    assert.equal(error.retryAfterMs, 4_000)
    return true
  },
)
assert.equal(requests.length, 1, 'credential submission must not refresh or replay after a provider response')

requests.length = 0
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init })
  if (String(url) === '/api/refresh') {
    return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(JSON.stringify({ status: 'error', error_code: 'UNAUTHORIZED', message: 'fixture only' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

await assert.rejects(
  providerAuthApi.connect({ email: 'operator@example.test', password: 'not-a-real-password' }),
  (error: unknown) => error instanceof DashboardAuthExpiredError,
)
assert.deepEqual(
  requests.map((request) => ({ url: request.url, method: request.init?.method })),
  [
    { url: '/api/team/provider-auth', method: 'PUT' },
    { url: '/api/refresh', method: 'POST' },
  ],
  'a dashboard 401 may refresh the dashboard session but must never replay a credential PUT',
)

requests.length = 0
let getAttempts = 0
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init })
  if (String(url) === '/api/refresh') {
    return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  getAttempts += 1
  if (getAttempts === 1) {
    return new Response(JSON.stringify({ status: 'error', error_code: 'UNAUTHORIZED', message: 'fixture only' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(JSON.stringify({ status: 'success', data: statusFixture() }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
await providerAuthApi.get()
assert.deepEqual(
  requests.map((request) => request.url),
  ['/api/team/provider-auth', '/api/refresh', '/api/team/provider-auth'],
  'status reads retain the normal dashboard-auth refresh and retry behavior',
)

assert.equal(
  calculateProviderAuthCooldown(statusFixture(), Date.parse('2026-09-11T10:00:10.000Z')),
  20_000,
  'a successful status with retryAt null still observes the thirty-second manual action cooldown',
)
assert.equal(
  calculateProviderAuthCooldown(statusFixture({ retryAt: '2026-09-11T10:01:00.000Z' }), Date.parse('2026-09-11T10:00:10.000Z')),
  50_000,
  'stored retryAt takes precedence when it is later than the successful-login cooldown',
)
assert.equal(
  calculateProviderAuthCooldown(statusFixture({ retryAt: 'not-a-date', lastLoginAt: null }), Date.parse('2026-09-11T10:00:10.000Z')),
  0,
  'invalid or absent timestamps cannot produce a negative or invalid cooldown',
)
assert.equal(getProviderAuthErrorCopy('PROVIDER_AUTH_UNAVAILABLE'), 'ยังเชื่อมต่อผู้ให้บริการไม่ได้ กรุณาลองใหม่อีกครั้ง')
assert.equal(getProviderAuthErrorCopy('challenge_required'), 'ผู้ให้บริการต้องการยืนยันตัวตน กรุณาเข้าสู่ MyAgencyService เพื่อทำขั้นตอนยืนยันตัวตนให้เสร็จ แล้วกลับมากดเชื่อมต่ออีกครั้ง')
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: statusFixture({ status: 'connected' }) }),
  true,
  'panel must be hidden when hideWhenConnected is true and status is healthy connected',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, forceExpand: true, status: statusFixture({ status: 'connected' }) }),
  false,
  'panel must not be hidden when forceExpand is true',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: statusFixture({ status: 'attention' }) }),
  false,
  'panel must be shown when status is attention',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: statusFixture({ status: 'retry_wait' }) }),
  false,
  'panel must be shown when status is retry_wait',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: statusFixture({ status: 'connected' }), feedbackCode: 'PROVIDER_AUTH_FAILED' }),
  false,
  'panel must be shown when feedbackCode error is present',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: statusFixture({ status: 'connected' }), isCoolingDown: true }),
  false,
  'panel must be shown when cooling down',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: statusFixture({ status: 'connected' }), hasError: true }),
  false,
  'panel must be shown when query has error',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: false, status: statusFixture({ status: 'connected' }) }),
  false,
  'panel must remain visible by default when hideWhenConnected is false',
)
assert.equal(
  shouldHideProviderAuthPanel({ hideWhenConnected: true, status: null }),
  true,
  'initial loading with hideWhenConnected must suppress flash before connection status arrives',
)

globalThis.fetch = originalFetch
console.log('frontend-provider-auth: all assertions passed')
}

void run()
