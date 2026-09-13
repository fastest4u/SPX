import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, type BrowserContext, type Page, type Route } from 'playwright'

export const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 844, height: 390 }]
export async function runOperatorE2e(role: 'admin' | 'user', pages: { path: string; heading: string }[]) {
  const { buildE2eEnv } = await import('../scripts/e2e-runner.mjs')
  const clean = buildE2eEnv(process.env)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, clean)
  const { resetMemoryDb } = await import('../src/db/client-memory.js')
  const { createTeam } = await import('../src/repositories/team-repository.js')
  const { createUser } = await import('../src/repositories/user-repository.js')
  const { insertAutoAcceptHistory } = await import('../src/repositories/auto-accept-repository.js')
  const { insertLineImageExtraction } = await import('../src/repositories/line-image-extraction-repository.js')
  const { createHttpServer } = await import('../src/services/http-server.js')
  resetMemoryDb()
  const own = await createTeam({ name: 'Default Team', enabled: true, lineGroupId: 'csynthetic-group' })
  const other = await createTeam({ name: 'Other Team', enabled: true })
  await createUser('operator', 'synthetic-password-123', role, role === 'user' ? own.id : null)
  for (const team of [own, other]) for (const status of ['success', 'failed', 'indeterminate'] as const) {
    await insertAutoAcceptHistory(team.id, { ruleId: status, ruleName: `${team.id === own.id ? 'Own' : 'Other'} ${status}`, bookingId: 123, requestIds: status === 'success' ? [101] : [], acceptedCount: status === 'success' ? 1 : 0, origin: 'NERC', destination: 'SOCE', vehicleType: '6WH', status })
  }
  await insertLineImageExtraction({ chatId: 'synthetic', senderId: 'synthetic', imagePath: 'synthetic.png', dateText: '2026-09-12', tripNumber: 'TRIP-123', driverName: 'คนขับทดสอบ', agencyName: 'LH-PWL', vehicleType: '6WH', route: 'NERC > SOCE', rawText: 'synthetic' })
  const server = await createHttpServer({ surface: 'web-api' })
  const { logger } = await import('../src/utils/logger.js')
  const originalInfo = logger.info
  logger.info = () => {}
  const originalFetch = globalThis.fetch
  const failures: string[] = []
  globalThis.fetch = async () => { failures.push('Unexpected server external fetch'); throw new Error('E2E forbids server external fetch') }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const output = `output/playwright/operator-${role}`
  mkdirSync(output, { recursive: true })
  const blocked: string[] = [], requests: string[] = [], negatives: string[] = []
  try {
    const origin = await server.listen({ host: '127.0.0.1', port: 0 })
    console.log(`Hermetic ${role}: ${origin}; DB_MODE=memory; env-file loading disabled`)
    browser = await chromium.launch({ headless: clean.E2E_HEADLESS !== 'false' })
    let manualMode: 'pending' | 'confirmed' | 'transport' | 'rejected' | 'deferred' = 'pending'
    let deferred: (() => Promise<void>) | undefined
    let manualCalls = 0
    let historyFailure = false
    let teamsFailure = false
    const expectedForbidden = new Map<string, number>()
    let rateRemaining = 120, rateResetAt = 0
    let scenario: 'fresh' | 'stopped' | 'stale' | 'missing' | null = role === 'user' ? 'stopped' : null
    async function setup(context: BrowserContext) {
      await context.addInitScript((allowedOrigin) => { if (location.origin === allowedOrigin) localStorage.setItem('spx:coachmark:v1', '1') }, origin)
      context.on('page', (page) => page.on('pageerror', (error) => failures.push(`pageerror ${error.message}`)))
      context.on('response', (response) => {
        const headers = response.headers()
        if (headers['x-ratelimit-limit'] === '120') { rateRemaining = Number(headers['x-ratelimit-remaining']); rateResetAt = Number(headers['x-ratelimit-reset']) * 1000 }
        if (response.status() < 400) return
        const url = new URL(response.url()), method = response.request().method()
        const entry = `${method} ${url.pathname} ${response.status()}`
        const forbiddenBudget = expectedForbidden.get(url.pathname) ?? 0
        if (role === 'user' && method === 'GET' && response.status() === 403 && forbiddenBudget > 0) {
          expectedForbidden.set(url.pathname, forbiddenBudget - 1); negatives.push(entry); return
        }
        if ((url.pathname === '/api/me' && response.status() === 401) || (url.pathname === '/api/login' && response.status() === 401) || (url.pathname === '/api/bidding/accept-all' && [409, 502].includes(response.status())) || (url.pathname === '/api/auto-accept-history/paginated' && response.status() === 503 && historyFailure) || (url.pathname === '/api/teams' && response.status() === 503 && teamsFailure)) negatives.push(entry)
        else failures.push(entry)
      })
      context.on('requestfailed', (request) => {
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(new URL(request.url()).hostname)) { blocked.push(`${request.url()} (${request.failure()?.errorText})`); return }
        // Navigation/context disposal can cancel a read or SSE stream. Mutations and genuine network failures still fail.
        if (request.method() === 'GET' && request.failure()?.errorText === 'net::ERR_ABORTED') return
        failures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`)
      })
      await context.route('**/*', async (route: Route) => {
        const req = route.request(), url = new URL(req.url()), method = req.method()
        requests.push(`${method} ${url.pathname}`)
        if (url.origin !== origin) {
          blocked.push(req.url())
          if (!['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) failures.push(`Unexpected external ${req.url()}`)
          await route.fulfill({ status: 200, contentType: 'text/css', body: '' }); return
        }
        const data = (value: unknown, status = 200) => route.fulfill({ status, json: value })
        if (url.pathname === '/api/line-bot/status') return data({ status: 'success', data: { enabled: true, authenticated: true, sessionKey: 'synthetic', device: 'IOSIPAD' } })
        if (url.pathname === '/api/line-bot/groups') return data({ status: 'success', data: { chats: [{ chatMid: 'csynthetic-group', chatName: 'Synthetic Group' }] } })
        if (/^\/api\/(?:teams\/\d+|team)\/provider-auth$/.test(url.pathname) && method === 'GET') return data({ status: 'success', data: { teamId: own.id, email: null, hasPassword: false, status: 'disconnected', lastLoginAt: null, expiresAt: null, errorCode: null, retryAt: null } })
        if (url.pathname === '/api/ai/codex-auth/status') return data({ status: 'success', data: { authenticated: false, status: 'logged_out' } })
        if (url.pathname.startsWith('/line-images/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="gray"/></svg>' })
        if (url.pathname === '/api/bidding/accept-all' && method === 'POST') {
          manualCalls++
          const input = req.postDataJSON() as { teamId: number; bookingId: number }
          const fulfill = async () => { await data({ status: 'success', data: { ...input, acceptAll: true, acceptedCount: 7, verifiedAcceptedCount: manualMode === 'confirmed' ? 2 : 0, verificationStatus: manualMode === 'confirmed' ? 'verified_success' : 'indeterminate', requestIds: manualMode === 'confirmed' ? [101, 102] : [], notified: false } }) }
          if (manualMode === 'deferred') { deferred = fulfill; return }
          if (manualMode === 'transport' || manualMode === 'rejected') return data({ status: 'error', error_code: 'ACCEPT_ALL_FAILED', message: manualMode === 'transport' ? 'upstream transport failed' : 'request unsuccessful' }, manualMode === 'transport' ? 502 : 409)
          return fulfill()
        }
        if (url.pathname === '/api/teams' && teamsFailure) return data({ status: 'error', error_code: 'SYNTHETIC', message: 'temporary teams failure' }, 503)
        if (url.pathname === '/api/auto-accept-history/paginated' && historyFailure) return data({ status: 'error', error_code: 'SYNTHETIC', message: 'temporary history failure' }, 503)
        if (url.pathname === '/api/team' && scenario) return data({ status: 'success', data: { ...own, runtimeStatus: scenario === 'stopped' ? 'stopped' : 'running', hasSpxCookie: true, hasSpxDeviceId: true } })
        if (url.pathname === '/metrics' && scenario) return data({
          teamId: own.id, uptime: 60, startedAt: new Date(Date.now() - 60_000).toISOString(), isPaused: false,
          lastPoll: { timestamp: scenario === 'missing' ? null : new Date(Date.now() - (scenario === 'stale' ? 180_000 : 10_000)).toISOString(), status: 'same', latencyMs: 120, recordCount: 4 },
          polling: { totalRequests: 1, successCount: 1, errorCount: 0, successRate: 100, latency: { avg: 120, min: 120, max: 120, p50: 120, p95: 120, p99: 120 } },
          session: { isHealthy: true, consecutiveErrors: 0, lastSessionWarning: null }, database: null,
          data: { totalRecordsSeen: 4, changesDetected: 0, tripsInserted: 0, tripsSkipped: 0 },
          autoAccept: { totalAttempts: 0, successCount: 0, failureCount: 0 }, scheduling: { launched: 0, skippedConcurrency: 0, skippedCooldown: 0 },
          upstream: { requests: 1, connections: 1, reuseRatio: 0 }, operations: {},
          runtime: { activeDetailJobs: 0, activeDetailBookings: 0, detailConcurrency: 4, queuedDetailBookings: 0, detailQueuePressure: 0, sseClients: 1 },
        })
        const reads = /^\/(?:api\/(?:me|team|teams(?:\/\d+)?|rules(?:\/[^/]+)?|users|history(?:\/paginated|\/filter-options)?|audit-logs(?:\/paginated)?|auto-accept-history(?:\/paginated)?|line-image-extractions|settings)|metrics(?:\/history)?|events|health|ready|line-quota)$/
        const writes = /^\/api\/(?:login|logout|refresh|rules(?:\/(?!preview$)[^/]+)?|teams(?:\/\d+)?|users(?:\/\d+(?:\/(?:password|role|team))?)?)$/
        if (method !== 'GET' || url.pathname.startsWith('/api/') || ['/metrics','/events','/line-quota'].some((path) => url.pathname.startsWith(path))) {
          if (!(method === 'GET' ? reads.test(url.pathname) : writes.test(url.pathname))) {
            failures.push(`Unexpected local action ${method} ${url.pathname}`)
            return data({ status: 'error', error_code: 'FENCED', message: 'Unexpected E2E action' }, 418)
          }
          if (method !== 'GET' && url.pathname === '/api/rules' && req.postDataJSON().enabled !== false) {
            failures.push('E2E rule must remain disabled'); return data({}, 418)
          }
        }
        return route.continue()
      })
    }
    async function login(page: Page, validate = false) {
      await page.goto(`${origin}/login`)
      await page.getByRole('heading', { name: 'เข้าสู่ระบบ', exact: true }).waitFor()
      if (validate) {
        await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
        await page.getByText('กรุณากรอกชื่อผู้ใช้', { exact: true }).waitFor()
        assert.equal(await page.locator('#login-username').getAttribute('aria-invalid'), 'true')
        assert.equal(await page.locator('#login-username').evaluate((el) => document.activeElement === el), true)
        await page.locator('#login-username').fill('operator')
        await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
        await page.getByText('กรุณากรอกรหัสผ่าน', { exact: true }).waitFor()
        assert.equal(await page.locator('#login-password').evaluate((el) => document.activeElement === el), true)
        const toggle = page.getByRole('button', { name: 'แสดงรหัสผ่าน' })
        await page.keyboard.press('Tab')
        assert.notEqual(await toggle.evaluate((el) => getComputedStyle(el).boxShadow), 'none', 'password toggle has a visible focus ring')
        assert.equal(await page.locator('#login-username').getAttribute('name'), 'username')
        assert.equal(await page.locator('#login-password').getAttribute('autocomplete'), 'current-password')
        await page.keyboard.press('Enter')
        assert.equal(await page.locator('#login-password').getAttribute('type'), 'text')
        await page.getByRole('button', { name: 'ซ่อนรหัสผ่าน' }).click()
        const box = await toggle.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44)
        await page.locator('#login-password').fill('wrong-password')
        await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
        await page.getByRole('alert').waitFor()
        await page.screenshot({ path: `${output}/login-validation-1440x900.png`, fullPage: true })
      }
      await page.locator('#login-username').fill('operator')
      await page.locator('#login-password').fill('synthetic-password-123')
      await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
      await page.waitForURL(`${origin}/`)
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
    await setup(context)
    const page = await context.newPage(); page.setDefaultTimeout(12_000)
    await login(page, true)
    await page.getByRole('heading', { name: 'ภาพรวมระบบ', exact: true }).waitFor()
    await page.getByRole('link', { name: /ประวัติรับงาน/ }).first().click()
    await page.getByRole('heading', { name: 'ประวัติการรับงานอัตโนมัติ', exact: true }).waitFor()
    if (role === 'user') {
      assert.equal(await page.locator('#accept-all-team').count(), 0)
      assert.equal(await page.getByRole('link', { name: 'LINE Runsheets', exact: true }).count(), 0)
      assert.equal(await page.getByText('Other indeterminate', { exact: true }).count(), 0)
    }
    await page.getByRole('button', { name: 'ตัวกรองประวัติรับงาน', exact: true }).click()
    for (const status of ['indeterminate', 'success', 'failed']) {
      await page.getByLabel('สถานะ', { exact: true }).selectOption(status)
      await page.getByRole('row').getByText(`Own ${status}`, { exact: true }).waitFor()
      const rows = page.locator('tbody tr'); assert.equal(await rows.count(), role === 'admin' ? 2 : 1)
    }
    await page.getByLabel('สถานะ', { exact: true }).selectOption('')
    const search = page.getByRole('textbox', { name: 'ค้นหาประวัติรับงาน', exact: true })
    await search.fill('no-result-synthetic')
    await page.getByText('ไม่พบประวัติการรับงานอัตโนมัติ', { exact: true }).last().waitFor()
    await page.getByRole('button', { name: 'ล้างคำค้นหาประวัติรับงาน', exact: true }).click()
    assert.equal(await search.evaluate((el) => document.activeElement === el), true)
    await page.getByRole('row').getByText('Own success', { exact: true }).waitFor()
    if (role === 'admin') {
      await page.locator('#accept-all-team').selectOption(String(own.id))
      await page.locator('#accept-all-booking').fill('123')
      assert.equal(await page.getByRole('button', { name: 'accept_all', exact: true }).isDisabled(), true)
      for (const mode of ['pending', 'confirmed', 'transport', 'rejected'] as const) {
        manualMode = mode
        await page.getByLabel('ยืนยัน', { exact: true }).check()
        await page.getByRole('button', { name: 'accept_all', exact: true }).click()
        const panel = page.getByRole('status', { name: 'ผลการส่งคำขอรับงาน' })
        await panel.waitFor()
        await page.getByRole('button', { name: 'accept_all', exact: true }).waitFor()
        if (mode === 'confirmed') { await panel.getByText('ยืนยันงานที่รับใหม่ 2 งาน', { exact: true }).waitFor(); assert.ok((await panel.innerText()).includes('เฉพาะ')) }
        else { await panel.getByText(/ตรวจสอบ.*ก่อนส่งซ้ำ/).waitFor(); assert.ok(!(await panel.innerText()).includes('ยืนยันงานที่รับใหม่ 7')) }
        await page.screenshot({ path: `${output}/manual-${mode}-1440x900.png`, fullPage: true })
        if (mode === 'pending') {
          await page.setViewportSize(viewports[0])
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'pending result at 320px has no document overflow')
          const submit = page.getByRole('button', { name: 'accept_all', exact: true })
          await submit.scrollIntoViewIfNeeded()
          assert.equal(await submit.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), true)
          await page.locator('[data-sonner-toast]').last().waitFor({ state: 'hidden' })
          await panel.getByText(/ตรวจสอบ.*ก่อนส่งซ้ำ/).evaluate((el) => el.scrollIntoView({ block: 'center' }))
          await page.screenshot({ path: `${output}/manual-pending-320x568.png`, fullPage: true })
          await page.setViewportSize({ width: 1440, height: 900 })
        }
        await page.locator('#accept-all-booking').fill(String(130 + manualCalls))
        assert.equal(await panel.count(), 0)
      }
      manualMode = 'deferred'
      await page.getByLabel('ยืนยัน', { exact: true }).check()
      await page.getByRole('button', { name: 'accept_all', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('button svg.animate-spin'))
      await page.locator('#accept-all-booking').fill('999')
      assert.ok(deferred); await deferred()
      await page.waitForFunction(() => !document.querySelector('button svg.animate-spin'))
      assert.equal(await page.getByRole('status', { name: 'ผลการส่งคำขอรับงาน' }).count(), 0)
      assert.equal(manualCalls, 5, 'no automatic mutation retry')
    }
    // Current semantic RuleEditor controls; disabled CRUD cannot invoke provider preview.
    await page.goto(`${origin}/`)
    await page.getByRole('button', { name: 'เพิ่มรายการ', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#rule-name').fill('Synthetic Rule')
    if (role === 'admin') { await dialog.locator('#rule-team').selectOption(String(own.id)); await dialog.getByLabel('รับทั้ง booking แม้จำนวนคันเกินเป้าหมาย', { exact: true }).check() }
    else { assert.equal(await dialog.locator('#rule-team').count(), 0); assert.equal(await dialog.getByLabel('รับทั้ง booking แม้จำนวนคันเกินเป้าหมาย', { exact: true }).count(), 0) }
    await dialog.locator('#rule-origins').fill('NERC')
    await dialog.locator('#rule-destinations').fill('SOCE')
    await dialog.locator('#rule-need').fill('2')
    await dialog.getByRole('button', { name: 'สร้างรายการแบบปิดไว้', exact: true }).click()
    let row = page.getByRole('row').filter({ hasText: 'Synthetic Rule' })
    await row.getByText('ปิดอยู่', { exact: true }).waitFor()
    await row.getByRole('button', { name: 'แก้ไข', exact: true }).click()
    await dialog.locator('#rule-name').fill('Synthetic Rule Edited')
    await dialog.getByRole('button', { name: 'บันทึกการแก้ไข', exact: true }).click()
    row = page.getByRole('row').filter({ hasText: 'Synthetic Rule Edited' })
    await row.getByRole('button', { name: 'ลบ', exact: true }).click()
    const ruleDeletionFinished = page.waitForEvent('requestfinished', (request) => request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/api/rules/'))
    await dialog.getByRole('button', { name: 'ลบรายการ', exact: true }).click()
    await ruleDeletionFinished
    await row.waitFor({ state: 'detached' })
    if (role === 'admin') {
      await page.goto(`${origin}/teams`)
      await page.getByRole('button', { name: 'เพิ่มทีม', exact: true }).click()
      await dialog.getByLabel('ชื่อทีม', { exact: true }).fill('Synthetic Team')
      await dialog.locator('#team-line').selectOption('csynthetic-group')
      await dialog.getByRole('button', { name: 'บันทึกทีม', exact: true }).click()
      await dialog.getByRole('heading', { name: 'แก้ไขทีม', exact: true }).waitFor()
      await dialog.getByLabel('ชื่อทีม', { exact: true }).fill('Synthetic Team Edited')
      await dialog.getByRole('button', { name: 'บันทึกทีม', exact: true }).click()
      await page.getByRole('row').filter({ hasText: 'Synthetic Team Edited' }).waitFor()
      await page.goto(`${origin}/users`)
      await page.getByRole('button', { name: 'เพิ่มผู้ใช้', exact: true }).click()
      await dialog.locator('#create-user-username').fill('synthetic-created-user')
      await dialog.locator('#create-user-password').fill('synthetic-user-password')
      await dialog.locator('#create-user-role').selectOption('user')
      await dialog.locator('#create-user-team').selectOption(String(own.id))
      await dialog.locator('button[type="submit"]').click()
      const userRow = page.getByRole('row').filter({ hasText: 'synthetic-created-user' })
      await userRow.getByRole('button', { name: 'รหัสผ่าน', exact: true }).click()
      await dialog.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('synthetic-replaced-password')
      await dialog.getByLabel('ยืนยันรหัสผ่าน', { exact: true }).fill('synthetic-replaced-password')
      await dialog.locator('button[type="submit"]').click()
      await userRow.getByRole('button', { name: 'ลบ', exact: true }).click()
      const deletionFinished = page.waitForEvent('requestfinished', (request) => request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/api/users/'))
      await dialog.getByRole('button', { name: 'ลบผู้ใช้', exact: true }).click()
      await deletionFinished
      await userRow.waitFor({ state: 'detached' })
    }
    // A failed dependency cannot turn manual submission into an available action.
    if (role === 'admin') {
      teamsFailure = true
      await page.goto(`${origin}/auto-accept-history`)
      await page.getByRole('heading', { name: 'โหลดรายชื่อทีมไม่สำเร็จ', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'accept_all', exact: true }).isDisabled(), true)
      await page.locator('#accept-all-booking').fill('987')
      teamsFailure = false
      await page.getByRole('button', { name: 'ลองใหม่', exact: true }).click()
      await page.locator('#accept-all-team option').filter({ hasText: 'Default Team' }).waitFor({ state: 'attached' })
      assert.equal(await page.locator('#accept-all-booking').inputValue(), '987')
    }
    historyFailure = true
    await page.goto(`${origin}/auto-accept-history`)
    await page.getByRole('heading', { name: 'โหลดประวัติการรับงานไม่สำเร็จ', exact: true }).waitFor()
    await page.screenshot({ path: `${output}/history-error-1440x900.png`, fullPage: true })
    historyFailure = false
    await page.getByRole('button', { name: 'ลองใหม่', exact: true }).click()
    await page.getByRole('row').getByText('Own success', { exact: true }).waitFor()
    if (role === 'user') for (const state of ['fresh', 'stopped', 'stale', 'missing'] as const) {
      scenario = state
      await page.goto(`${origin}/`)
      await page.locator('main').getByText(({ fresh: 'Live', stopped: 'Stopped', stale: 'Stale', missing: 'Unknown' })[state], { exact: true }).waitFor()
      await page.screenshot({ path: `${output}/dashboard-${state}-1440x900.png`, fullPage: true })
    }
    scenario = role === 'user' ? 'stopped' : null
    if (role === 'user') {
      // These budgets belong only to the following deliberate forbidden-route probes.
      for (const [path, count] of [['/api/users', 1], ['/api/teams', 2], ['/api/settings', 1], ['/api/audit-logs/paginated', 1], ['/api/line-image-extractions', 1]] as const) expectedForbidden.set(path, count)
    }
    if (role === 'user') for (const path of ['/users', '/teams', '/settings', '/audit', '/LiNe-ImAgE-ExTrAcTiOnS']) {
      await page.goto(`${origin}${path}`); await page.waitForURL(`${origin}/`)
    }
    for (const viewport of viewports) {
      if (rateRemaining < 40 && rateResetAt > Date.now()) {
        const delay = Math.min(60_000, rateResetAt - Date.now() + 100)
        console.log(`Respecting HTTP rate limit before ${viewport.width}x${viewport.height}: waiting ${delay}ms`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      console.log(`${role} viewport ${viewport.width}x${viewport.height}`)
      await page.setViewportSize(viewport)
      for (const target of pages) {
        await page.goto(`${origin}${target.path}`)
        await page.getByRole('heading', { name: target.heading, exact: true }).waitFor()
        assert.ok(await page.locator('aside').count() > 0)
        assert.equal(await page.locator('aside').first().isVisible(), viewport.width >= 1024, 'current shared sidebar uses hidden/lg:flex')
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${role} ${target.path} overflow ${viewport.width}`)
        if (target.path === '/auto-accept-history' && viewport.width < 1024) {
          const menuButton = page.getByRole('button', { name: 'เปิดเมนูหลัก', exact: true })
          await menuButton.click()
          await page.getByRole('dialog').getByRole('link', { name: /ประวัติรับงาน/ }).waitFor()
          await page.keyboard.press('Escape')
          assert.equal(await menuButton.evaluate((el) => document.activeElement === el), true)
        }
        if (target.path === '/line-image-extractions') {
          const container = viewport.width < 768 ? page.getByRole('article').filter({ hasText: 'TRIP-123' }) : page.getByRole('row').filter({ hasText: 'TRIP-123' })
          await container.waitFor()
          for (const text of ['TRIP-123', 'คนขับทดสอบ', 'LH-PWL', '6WH', 'NERC > SOCE', '2026-09-12']) assert.ok((await container.innerText()).includes(text))
          const imageAction = container.getByRole('link', { name: /เปิดภาพ.*TRIP-123/ })
          await imageAction.waitFor()
          await imageAction.scrollIntoViewIfNeeded()
          const imageBox = await imageAction.boundingBox(); assert.ok(imageBox)
          assert.equal(await imageAction.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), true, 'image action is reachable and not obscured')
          if (viewport.width < 768) await page.screenshot({ path: `${output}/runsheet-card-visible-${viewport.width}x${viewport.height}.png`, fullPage: true })
          await page.getByRole('button', { name: 'ตัวกรอง LINE Runsheets', exact: true }).click()
          const driver = page.getByLabel('คนขับ', { exact: true }); await driver.focus()
          assert.equal(await driver.evaluate((el) => document.activeElement === el), true)
          await page.getByRole('button', { name: 'ตัวกรอง LINE Runsheets', exact: true }).click()
          const runsheetSearch = page.getByRole('textbox', { name: 'ค้นหา LINE Runsheets', exact: true })
          await runsheetSearch.fill('synthetic-no-record')
          const empty = page.getByText('ไม่พบใบงานที่บันทึกไว้', { exact: true })
          await (viewport.width < 768 ? empty.first() : empty.last()).waitFor()
          await page.getByRole('button', { name: 'ล้างคำค้นหา LINE Runsheets', exact: true }).click()
          assert.equal(await runsheetSearch.evaluate((el) => document.activeElement === el), true)
          await container.waitFor()
        }
        if (['/auto-accept-history', '/line-image-extractions', '/'].includes(target.path)) await page.screenshot({ path: `${output}/${target.path.slice(1) || 'dashboard'}-${viewport.width}x${viewport.height}.png`, fullPage: true })
      }
    }
    await context.close()
    // Mobile form comes before supporting content in both reading and visual order.
    const loginContext = await browser.newContext({ viewport: viewports[0], serviceWorkers: 'block', reducedMotion: 'reduce' }); await setup(loginContext)
    const loginPage = await loginContext.newPage(); await loginPage.goto(`${origin}/login`)
    const form = loginPage.locator('form'), hero = loginPage.getByRole('heading', { name: 'BOT Control Center', exact: true })
    await form.waitFor()
    assert.ok((await form.boundingBox())!.y < (await hero.boundingBox())!.y)
    assert.equal(await form.evaluate((el) => Boolean(el.compareDocumentPosition(document.querySelector('h1')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
    await loginPage.screenshot({ path: `${output}/login-320x568.png`, fullPage: true })
    await loginContext.close()
    assert.deepEqual(failures, [], 'browser HTTP/network/runtime gates')
    console.log(`${role} E2E passed; manualCalls=${manualCalls}; blocked external font attempts=${blocked.length}`)
  } catch (error) {
    for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
      await page.screenshot({ path: `${output}/failure-${Date.now()}.png`, fullPage: true }).catch(() => {})
    }
    throw error
  } finally {
    writeFileSync(`${output}/network.json`, JSON.stringify({ blocked, requests: [...new Set(requests)], negatives, failures }, null, 2))
    await browser?.close()
    await server.close()
    globalThis.fetch = originalFetch
    logger.info = originalInfo
  }
}
