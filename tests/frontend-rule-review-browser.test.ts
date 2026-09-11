import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'
import type { RuleInput } from '../src/frontend/types'

async function run() {
  const server = await createServer({
    configFile: false, envDir: false, root: process.cwd(), cacheDir: 'node_modules/.vite-rule-review-tests', plugins: [tailwindcss(), react()],
    optimizeDeps: { entries: ['tests/rule-review-fixture.html'] }, server: { port: 0, watch: null },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    for (const scenario of [
      { role: 'user', openingMode: false, serverMode: true, expectedMode: true },
      { role: 'user', openingMode: true, serverMode: false, expectedMode: false },
      { role: 'admin', openingMode: false, serverMode: false, expectedMode: true },
    ]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      page.setDefaultTimeout(10_000)
      let latestPreview: RuleInput | undefined
      let saved: RuleInput | undefined
      let latestToken = ''
      let previews = 0
      await page.route('**/api/**', async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (path === '/api/rules/preview') {
          const body = request.postDataJSON() as { rule: RuleInput; ruleId: string }
          assert.equal(body.ruleId, 'fixture-rule')
          latestPreview = { ...body.rule, accept_all: scenario.role === 'admin' ? body.rule.accept_all : scenario.serverMode }
          latestToken = `synthetic-review-${++previews}`
          await route.fulfill({ json: { status: 'success', data: {
            ruleId: 'fixture-rule', ruleName: latestPreview.name, need: latestPreview.need,
            acceptAll: latestPreview.accept_all, matchedCount: 0, scannedCount: 0, sampleSize: 0, trips: [], wouldMatch: false,
            review: { token: latestToken, expiresAt: new Date(Date.now() + 300_000).toISOString(), wildcardFields: [], acceptAll: latestPreview.accept_all },
          } } })
        } else if (path === '/api/rules/fixture-rule' && request.method() === 'PUT') {
          saved = request.postDataJSON() as RuleInput
          await route.fulfill({ json: { status: 'success', data: saved } })
        } else throw new Error(`Unexpected fixture request: ${request.method()} ${path}`)
      })
      await page.goto(`${server.resolvedUrls!.local[0]}tests/rule-review-fixture.html?role=${scenario.role}&mode=${scenario.openingMode ? 'all' : 'normal'}`, { timeout: 30_000 })
      await page.getByRole('button', { name: 'Open editor' }).click()
      await page.fill('#rule-name', 'User edited route')
      await page.fill('#rule-origins', 'Edited origin')
      await page.fill('#rule-need', '3')
      if (scenario.role === 'admin') await page.getByLabel('รับทั้ง booking แม้จำนวนคันเกินเป้าหมาย', { exact: true }).check()
      await page.getByRole('button', { name: 'ตรวจผลก่อนเปิดใช้งาน', exact: true }).click()
      await page.getByRole('heading', { name: 'ตรวจขอบเขตก่อนบันทึก' }).waitFor()
      const summary = page.getByText('รับทั้ง booking — จำนวนคันอาจเกินเป้าหมาย', { exact: true })
      assert.equal(await summary.count(), scenario.expectedMode ? 1 : 0, 'summary must show the permission-normalized server mode')
      const submit = page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน', exact: true })
      if (scenario.expectedMode) {
        assert.equal(await submit.isDisabled(), true, 'the refreshed whole-booking mode requires explicit acknowledgement')
        await page.getByLabel('ยืนยันให้รับทั้ง booking แม้เกินเป้าหมาย 3 คัน', { exact: true }).check()
      }
      assert.equal(await submit.isEnabled(), true, 'a normal user can confirm the current mode without abandoning the form')

      // Going back must keep edits and the refreshed mode, while discarding acknowledgement/token.
      await page.getByRole('button', { name: 'กลับไปแก้ไข', exact: true }).click()
      assert.equal(await page.locator('#rule-name').inputValue(), 'User edited route')
      assert.equal(await page.locator('#rule-origins').inputValue(), 'Edited origin')
      assert.equal(await page.locator('#rule-need').inputValue(), '3')
      await page.getByRole('button', { name: 'ตรวจผลก่อนเปิดใช้งาน', exact: true }).click()
      await page.getByRole('heading', { name: 'ตรวจขอบเขตก่อนบันทึก' }).waitFor()
      if (scenario.expectedMode) {
        assert.equal(await submit.isDisabled(), true, 'a new preview requires a fresh acknowledgement')
        await page.getByLabel('ยืนยันให้รับทั้ง booking แม้เกินเป้าหมาย 3 คัน', { exact: true }).check()
      }
      await submit.click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.ok(saved)
      const { activationReview, ...payload } = saved
      assert.deepEqual(payload, latestPreview, 'save fields must match the effective fields covered by the latest review')
      assert.equal(payload.accept_all, scenario.expectedMode)
      assert.equal(activationReview?.token, latestToken)
      assert.equal(activationReview?.acknowledgeAcceptAll, scenario.expectedMode)
      await page.close()
    }
    console.log('frontend-rule-review-browser: concurrent mode changes, preserved edits, acknowledgement and bound save payload passed')
  } finally {
    await browser.close()
    await server.close()
  }
}

void run().catch((error) => { console.error(error); process.exitCode = 1 })
