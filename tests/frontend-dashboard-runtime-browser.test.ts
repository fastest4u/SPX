import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'
import { browserFixtureServerOptions } from './browser-fixture-server.js'

type Scenario = 'fresh' | 'near-stale' | 'stopped' | 'runtime-recovery' | 'stale' | 'missing' | 'paused' | 'poll-error' | 'session-expired' | 'mismatched' | 'disabled' | 'admin'
declare global {
  interface Window {
    __dashboardRuntimeFixture: {
      setScenario(scenario: Scenario): void
      getCurrentTeamRequestCount(): number
    }
  }
}

const outputDir = 'output/playwright/dashboard-runtime'
mkdirSync(outputDir, { recursive: true })

async function run() {
  const server = await createServer({
    configFile: false,
    envDir: false,
    root: process.cwd(),
    cacheDir: 'node_modules/.vite-dashboard-runtime-tests',
    optimizeDeps: { entries: ['tests/dashboard-runtime-fixture.html'] },
    plugins: [tailwindcss(), react()],
    server: await browserFixtureServerOptions(),
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    browser = await chromium.launch({ headless: true })
    await server.listen()
    const baseUrl = server.resolvedUrls?.local[0]
    assert.ok(baseUrl, 'fixture Vite server exposes a local URL')
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
    const fixtureOrigin = new URL(baseUrl).origin
    const externalRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== fixtureOrigin) externalRequests.push(request.url())
    })
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(120_000)
    await page.clock.install()
    await page.goto(`${baseUrl}tests/dashboard-runtime-fixture.html`)
    await page.getByRole('heading', { name: 'ภาพรวมระบบ' }).waitFor()

    const setScenario = async (scenario: Scenario) => {
      await page.evaluate((next) => window.__dashboardRuntimeFixture.setScenario(next), scenario)
    }

    // Minimal header: one visible label; reason + provider health live in the status accessible name/tooltip.
    const status = (name: RegExp) => page.getByRole('status', { name })

    await page.getByText('ทำงานอยู่', { exact: true }).waitFor()
    await status(/^ทำงานอยู่: Worker ทำงานและมีผล poll ล่าสุด · บัญชีผู้ให้บริการ: ปกติ$/).waitFor()
    await page.getByRole('switch', { name: /กดเพื่อปิดระบบบิทของทีม PTWL/ }).waitFor()
    assert.equal(await page.getByText('บัญชีผู้ให้บริการ: ปกติ', { exact: true }).count(), 0, 'healthy provider account stays out of the visual header')
    await page.screenshot({ path: `${outputDir}/mobile-fresh.png`, fullPage: true, animations: 'disabled' })

    await setScenario('stopped')
    await page.getByText('หยุดทำงาน', { exact: true }).waitFor()
    assert.equal(await page.getByText('ทำงานอยู่', { exact: true }).count(), 0)
    await status(/ทีมเปิดใช้งานอยู่ แต่ Worker หยุดทำงาน · บัญชีผู้ให้บริการ: ปกติ/).waitFor()
    await page.getByRole('switch', { name: /Worker หยุดทำงาน.*กดเพื่อปิดระบบบิท/ }).waitFor()
    await page.screenshot({ path: `${outputDir}/mobile-stopped.png`, fullPage: true, animations: 'disabled' })

    await setScenario('runtime-recovery')
    await page.getByText('หยุดทำงาน', { exact: true }).waitFor()
    const teamRequestsBeforeRefresh = await page.evaluate(() => window.__dashboardRuntimeFixture.getCurrentTeamRequestCount())
    await page.clock.runFor(30_001)
    await page.getByText('ทำงานอยู่', { exact: true }).waitFor()
    const teamRequestsAfterRefresh = await page.evaluate(() => window.__dashboardRuntimeFixture.getCurrentTeamRequestCount())
    assert.ok(teamRequestsAfterRefresh > teamRequestsBeforeRefresh, 'current-team query must refresh while the dashboard stays mounted')

    await setScenario('stale')
    await page.getByText('ไม่มีผล poll ใหม่', { exact: true }).waitFor()
    await status(/ไม่พบผล poll ใหม่ภายใน 120 วินาที · บัญชีผู้ให้บริการ: ล่าสุดปกติ \(ข้อมูลเก่า\)/).waitFor()
    await page.screenshot({ path: `${outputDir}/mobile-stale.png`, fullPage: true, animations: 'disabled' })

    await setScenario('missing')
    await page.getByText('กำลังตรวจสอบ…', { exact: true }).waitFor()
    await status(/บัญชีผู้ให้บริการ: ยังไม่ยืนยัน/).waitFor()
    await page.screenshot({ path: `${outputDir}/mobile-missing.png`, fullPage: true, animations: 'disabled' })

    await setScenario('mismatched')
    await page.getByText('กำลังตรวจสอบ…', { exact: true }).waitFor()
    assert.equal(await page.getByText('ทำงานอยู่', { exact: true }).count(), 0, 'wrong-team HTTP snapshot is excluded before dashboard consumption')

    await setScenario('paused')
    await page.getByText('พักชั่วคราว', { exact: true }).waitFor()
    await status(/Worker พักการ poll ชั่วคราว/).waitFor()

    await setScenario('poll-error')
    await page.getByText('มีข้อผิดพลาด', { exact: true }).waitFor()
    await status(/ผล poll ล่าสุดล้มเหลว \(network\) · บัญชีผู้ให้บริการ: ปกติ/).waitFor()

    await setScenario('session-expired')
    await page.getByText('Session หมดอายุ', { exact: true }).waitFor()
    await page.getByText('บัญชีผู้ให้บริการ: Session หมดอายุ', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'ไปยังบัญชีผู้ให้บริการ' }).waitFor()

    await setScenario('disabled')
    await page.getByText('ปิดอยู่', { exact: true }).waitFor()
    await page.getByRole('switch', { name: /กดเพื่อเปิดระบบบิทของทีม PTWL/ }).waitFor()

    await setScenario('near-stale')
    await page.getByText('ทำงานอยู่', { exact: true }).waitFor()
    await page.clock.runFor(6_000)
    await page.getByText('ไม่มีผล poll ใหม่', { exact: true }).waitFor()

    await setScenario('admin')
    await page.getByText('ทำงานปกติ', { exact: true }).waitFor()
    await status(/^ทำงานปกติ: Worker ทำงานและมีผล poll ล่าสุด$/).waitFor()
    assert.equal(await page.getByText('Unknown', { exact: true }).count(), 0, 'admin must not see a permanent team-scoped Unknown')
    assert.equal(await page.getByText('Admin Console', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('switch').count(), 0, 'admin runtime status remains read-only')

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `390px dashboard must not overflow horizontally (overflow=${overflow})`)
    assert.deepEqual(externalRequests, [], 'dashboard runtime fixture must not contact external services')
    await page.screenshot({ path: `${outputDir}/mobile-admin-unknown.png`, fullPage: true, animations: 'disabled' })
    await page.close()
    console.log('frontend-dashboard-runtime-browser: own/admin status, controls, freshness clock and 390x844 layout passed')
  } finally {
    await browser?.close()
    await server.close()
  }
}

void run()
