import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'
import { browserFixtureServerOptions } from './browser-fixture-server.js'

type FixtureControl = {
  setScenario(value: 'ready' | 'failure' | 'challenge' | 'rate-limit' | 'missing-account' | 'connecting' | 'connecting-stuck'): void
  reset(): void
  counts(): { reads: number; mutations: number }
  holdNextRead(): void
  releaseRead(): void
  holdNextMutation(): void
  releaseMutation(): void
  switchTeam(): void
}

declare global { interface Window { __providerFixture: FixtureControl } }

const outputDir = 'output/playwright/team-provider-auth'
mkdirSync(outputDir, { recursive: true })

async function assertNoPasswordPersistence(page: import('playwright').Page, password: string) {
  const browserState = await page.evaluate(() => JSON.stringify({
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    queryKeys: (window as typeof window & { __providerFixture: { cacheKeys(): unknown[] } }).__providerFixture.cacheKeys(),
  }))
  assert.equal(browserState.includes(password), false, 'password must not persist in browser storage or query-cache identifiers')
}

async function run() {
  const server = await createServer({
    configFile: false,
    envDir: false,
    root: process.cwd(),
    cacheDir: 'node_modules/.vite-provider-auth-tests',
    optimizeDeps: { entries: ['tests/provider-auth-fixture.html'] },
    plugins: [tailwindcss(), react()],
    server: await browserFixtureServerOptions(),
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const baseUrl = server.resolvedUrls?.local[0]
    assert.ok(baseUrl, 'fixture Vite server exposes a local URL')
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(30_000)
    await page.goto(`${baseUrl}tests/provider-auth-fixture.html`)
    await page.getByRole('heading', { name: 'บัญชีผู้ให้บริการ' }).waitFor()

    await page.fill('#provider-email-admin-team-7', '@')
    await page.fill('#provider-password-admin-team-7', 'synthetic-password')
    await page.getByRole('button', { name: 'แทนที่บัญชี' }).click()
    await page.getByText('กรุณากรอกอีเมลให้ถูกต้อง เช่น operator@example.com').waitFor()
    assert.equal(await page.locator('#provider-email-admin-team-7').getAttribute('aria-invalid'), 'true')
    assert.equal(await page.locator('#provider-email-admin-team-7').evaluate((element) => element === document.activeElement), true, 'invalid email receives first-invalid focus')
    await assertNoPasswordPersistence(page, 'synthetic-password')

    await page.fill('#provider-email-admin-team-7', 'replacement@example.test')
    await page.fill('#provider-password-admin-team-7', '')
    await page.locator('form').dispatchEvent('submit')
    await page.getByText('กรุณากรอกรหัสผ่านเพื่อเชื่อมต่อหรือแทนที่บัญชี').waitFor()
    assert.equal(await page.locator('#provider-password-admin-team-7').getAttribute('aria-invalid'), 'true')
    assert.equal(await page.locator('#provider-password-admin-team-7').evaluate((element) => element === document.activeElement), true, 'blank replacement password receives first-invalid focus')

    await page.evaluate(() => (window as typeof window & { __providerFixture: { setScenario(value: 'ready' | 'failure' | 'rate-limit' | 'missing-account'): void } }).__providerFixture.setScenario('missing-account'))
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'เปิดบัญชีผู้ให้บริการ' }).click()
    await page.getByRole('heading', { name: 'บัญชีผู้ให้บริการ' }).waitFor()
    await page.getByText('รหัสผ่าน:').waitFor()
    assert.equal(await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).isDisabled(), true, 'missing account cannot reconnect before a password is saved')
    await page.screenshot({ path: `${outputDir}/desktop-missing-account.png`, fullPage: true, animations: 'disabled' })

    await page.evaluate(() => (window as typeof window & { __providerFixture: { setScenario(value: 'ready' | 'failure' | 'rate-limit' | 'missing-account'): void } }).__providerFixture.setScenario('ready'))
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'เปิดบัญชีผู้ให้บริการ' }).click()
    await page.getByRole('heading', { name: 'บัญชีผู้ให้บริการ' }).waitFor()

    await page.fill('#provider-email-admin-team-7', 'success@example.test')
    await page.fill('#provider-password-admin-team-7', 'synthetic-password')
    await page.getByRole('button', { name: 'แทนที่บัญชี' }).click()
    await page.getByText(/ลองใหม่ได้ใน/).waitFor()
    await page.screenshot({ path: `${outputDir}/desktop-success-cooldown.png`, fullPage: true, animations: 'disabled' })
    await assertNoPasswordPersistence(page, 'synthetic-password')

    await page.evaluate(() => (window as typeof window & { __providerFixture: { reset(): void; setScenario(value: 'ready' | 'failure' | 'rate-limit' | 'missing-account'): void } }).__providerFixture.reset())
    await page.reload()
    await page.getByRole('heading', { name: 'บัญชีผู้ให้บริการ' }).waitFor()
    await page.evaluate(() => (window as typeof window & { __providerFixture: { setScenario(value: 'ready' | 'failure' | 'rate-limit' | 'missing-account'): void } }).__providerFixture.setScenario('failure'))
    await page.fill('#provider-email-admin-team-7', 'failure@example.test')
    await page.fill('#provider-password-admin-team-7', 'synthetic-password')
    await page.getByRole('button', { name: 'แทนที่บัญชี' }).click()
    await page.getByText('รอลองใหม่', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'ยังเชื่อมต่อผู้ให้บริการไม่ได้' }).waitFor()
    await page.getByText(/ลองใหม่ได้ใน/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).isDisabled(), true, 'failed replacement must immediately reflect the durable cooldown')
    assert.equal(await page.locator('#provider-password-admin-team-7').inputValue(), '')
    assert.equal(await page.locator('#provider-email-admin-team-7').inputValue(), 'failure@example.test', 'failed replacement preserves editable email')
    assert.deepEqual(await page.evaluate(() => window.__providerFixture.counts()), { reads: 1, mutations: 1 }, 'failed replacement performs one safe status read without credential replay')
    await page.screenshot({ path: `${outputDir}/desktop-error.png`, fullPage: true, animations: 'disabled' })
    await assertNoPasswordPersistence(page, 'synthetic-password')

    await page.reload()
    await page.getByText('รหัสผ่าน:').waitFor()
    await page.evaluate(() => window.__providerFixture.setScenario('rate-limit'))
    await page.fill('#provider-email-admin-team-7', 'rate-limit@example.test')
    await page.fill('#provider-password-admin-team-7', 'synthetic-password')
    await page.getByRole('button', { name: 'แทนที่บัญชี' }).click()
    await page.getByText(/ลองใหม่ได้ใน 10 วินาที/).waitFor()
    await page.screenshot({ path: `${outputDir}/desktop-rate-limit.png`, fullPage: true, animations: 'disabled' })

    await page.evaluate(() => (window as typeof window & { __providerFixture: { reset(): void } }).__providerFixture.reset())
    await page.reload()
    await page.getByRole('heading', { name: 'บัญชีผู้ให้บริการ' }).waitFor()
    await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).click()
    await page.getByText(/ลองใหม่ได้ใน/).waitFor()
    await page.screenshot({ path: `${outputDir}/desktop-reconnect.png`, fullPage: true, animations: 'disabled' })

    await page.reload()
    await page.getByText('รหัสผ่าน:').waitFor()
    await page.evaluate(() => window.__providerFixture.setScenario('challenge'))
    await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).click()
    await page.getByText('ต้องตรวจสอบ', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'ยืนยันตัวตน' }).waitFor()
    await page.getByText(/ลองใหม่ได้ใน/).waitFor()
    assert.deepEqual(await page.evaluate(() => window.__providerFixture.counts()), { reads: 1, mutations: 1 }, 'failed reconnect refreshes persisted challenge state without replay')
    await page.screenshot({ path: `${outputDir}/desktop-challenge.png`, fullPage: true, animations: 'disabled' })

    // A lease already active when the panel opens completes through safe bounded reads.
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.__providerFixture.reset(); window.__providerFixture.setScenario('connecting') })
    await page.getByRole('button', { name: 'เปิดบัญชีผู้ให้บริการ' }).click()
    await page.getByText('กำลังเชื่อมต่อ', { exact: true }).waitFor()
    await page.getByText('เชื่อมต่อแล้ว', { exact: true }).waitFor({ timeout: 20_000 })
    assert.equal((await page.evaluate(() => window.__providerFixture.counts())).mutations, 0, 'connecting refresh never submits credentials')

    // A status read captured before a team switch cannot overwrite the new team's status.
    await page.evaluate(() => window.__providerFixture.setScenario('failure'))
    await page.evaluate(() => window.__providerFixture.holdNextRead())
    await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).click()
    await page.waitForFunction(() => window.__providerFixture.counts().reads === 1)
    await page.evaluate(() => window.__providerFixture.switchTeam())
    await page.getByText('second-team@example.test', { exact: true }).waitFor()
    await page.evaluate(() => window.__providerFixture.releaseRead())
    await page.waitForTimeout(150)
    assert.equal(await page.getByText('second-team@example.test', { exact: true }).count(), 1, 'late previous-team GET cannot replace current status')
    assert.equal(await page.getByText('ต้องตรวจสอบ', { exact: true }).count(), 0)

    // A dismissed pending operation does not launch a refresh or write into a reopened form.
    await page.reload()
    await page.getByText('รหัสผ่าน:').waitFor()
    await page.evaluate(() => { window.__providerFixture.setScenario('failure'); window.__providerFixture.holdNextMutation() })
    await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).click()
    await page.waitForFunction(() => window.__providerFixture.counts().mutations === 1)
    await page.keyboard.press('Escape')
    await page.locator('#provider-password-admin-team-7').waitFor({ state: 'detached' })
    await page.evaluate(() => window.__providerFixture.releaseMutation())
    await page.waitForTimeout(150)
    assert.deepEqual(await page.evaluate(() => window.__providerFixture.counts()), { reads: 0, mutations: 1 }, 'late unmounted failure cannot issue a status read')
    await page.getByRole('button', { name: 'เปิดบัญชีผู้ให้บริการ' }).click()
    await page.getByText('รอลองใหม่', { exact: true }).waitFor()

    // An indefinitely active lease stops automatic GETs after a bounded budget.
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.__providerFixture.reset(); window.__providerFixture.setScenario('connecting-stuck') })
    await page.clock.install()
    await page.getByRole('button', { name: 'เปิดบัญชีผู้ให้บริการ' }).click()
    await page.getByText('กำลังเชื่อมต่อ', { exact: true }).waitFor()
    for (let poll = 0; poll < 25; poll += 1) {
      await page.clock.runFor(5_100)
      // React commits on the host event loop before scheduling the next safe read.
      await page.waitForTimeout(50)
    }
    await page.getByRole('button', { name: 'ตรวจสอบสถานะ', exact: true }).waitFor()
    const exhaustedCounts = await page.evaluate(() => window.__providerFixture.counts())
    assert.ok(exhaustedCounts.reads <= 26, 'connecting refresh is capped at 24 automatic reads plus initial StrictMode reads')
    await page.clock.runFor(60_000)
    assert.deepEqual(await page.evaluate(() => window.__providerFixture.counts()), exhaustedCounts, 'exhausted refresh must not continue polling')
    assert.equal(exhaustedCounts.mutations, 0)
    await page.screenshot({ path: `${outputDir}/desktop-connecting-refresh-exhausted.png`, fullPage: true, animations: 'disabled' })
    await page.evaluate(() => window.__providerFixture.setScenario('ready'))
    await page.getByRole('button', { name: 'ตรวจสอบสถานะ', exact: true }).click()
    await page.getByText('เชื่อมต่อแล้ว', { exact: true }).waitFor()

    // Even a transport that does not settle on abort cannot leave failure refresh pending forever.
    await page.evaluate(() => { window.__providerFixture.setScenario('failure'); window.__providerFixture.holdNextRead() })
    await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง' }).click()
    await page.waitForFunction(() => window.__providerFixture.counts().reads === 1)
    await page.clock.runFor(10_100)
    await page.getByText('ยังยืนยันสถานะไม่ได้', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'ลองใหม่', exact: true }).click()
    await page.getByText('รอลองใหม่', { exact: true }).waitFor()
    await page.evaluate(() => window.__providerFixture.releaseRead())
    assert.equal((await page.evaluate(() => window.__providerFixture.counts())).mutations, 1, 'timeout recovery retries only the status GET')

    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'เปิดบัญชีผู้ให้บริการ' }).waitFor()
    assert.equal(await page.locator('#provider-password-admin-team-7').count(), 0, 'Escape dismisses the dialog and unmounts its secret form')
    await assertNoPasswordPersistence(page, 'synthetic-password')

    const mobile = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' })
    await mobile.goto(`${baseUrl}tests/provider-auth-fixture.html`)
    await mobile.getByRole('heading', { name: 'บัญชีผู้ให้บริการ' }).waitFor()
    await mobile.getByLabel('อีเมล').focus()
    await mobile.keyboard.press('Tab')
    assert.equal(await mobile.locator('#provider-password-admin-team-7').evaluate((element) => element === document.activeElement), true, 'keyboard reaches the password field')
    await mobile.screenshot({ path: `${outputDir}/mobile-reduced-motion.png`, fullPage: true, animations: 'disabled' })
    await mobile.close()
    await page.close()
    console.log('frontend-provider-auth-browser: missing account, field validation/focus, success, error, reconnect, cooldown, storage/cache, dismissal, narrow and reduced-motion checks passed')
  } finally {
    await browser.close()
    await server.close()
  }
}

void run()
