process.env.DB_MODE = 'memory'
process.env.SECRETS_KEY = 'team-settings-fixture-key'

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'

async function main() {
  mkdirSync('output/playwright/team-provider-auth', { recursive: true })
  const { createTeam, listTeams, getTeamById, updateTeam } = await import('../src/repositories/team-repository.js')
  const { acquireTeamProviderAuthLease, commitTeamProviderAuth, getTeamProviderAuth, getTeamProviderAuthStatus } = await import('../src/repositories/team-provider-auth-repository.js')
  const { toTeamPatch } = await import('../src/controllers/teams-controller.js')
  const { closePool } = await import('../src/db/client.js')
  const { resetMemoryDb } = await import('../src/db/client-memory.js')
  resetMemoryDb()
  const team = await createTeam({ name: 'Empty session team', enabled: false, spxCookie: '', spxDeviceId: '', lineGroupId: 'C-fixture-line', autoAcceptSuccessLineGroupId: 'C-fixture-line', autoAcceptFailureLineGroupId: 'C-fixture-line' })
  const connect = async () => {
    const now = new Date()
    const lease = await acquireTeamProviderAuthLease(team.id, now)
    assert.ok(lease)
    assert.equal(await commitTeamProviderAuth(lease, { email: 'fixture@example.test', password: 'fixture-password' }, { cookie: 'spx_uk=fixture-cookie', deviceId: 'fixture-device', expiresAt: null }, now), true)
  }
  const server = await createServer({
    configFile: false, envDir: false, root: process.cwd(),
    cacheDir: 'node_modules/.vite-team-provider-auth-tests',
    optimizeDeps: { entries: ['tests/team-provider-auth-settings-fixture.html'] },
    plugins: [tailwindcss(), react()], server: { port: 0, watch: null },
  })
  const browser = await chromium.launch({ headless: true })
  const payloads: Array<Record<string, unknown>> = []
  try {
    await server.listen()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(30_000)
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url()).pathname
      let data: unknown
      if (url.endsWith('/provider-auth')) {
        if (request.method() === 'PUT') await connect()
        data = await getTeamProviderAuthStatus(team.id)
      } else if (url === '/api/teams') {
        data = (await listTeams()).map((item) => ({ ...item, runtimeStatus: 'stopped', usersCount: 0 }))
      } else if (url === `/api/teams/${team.id}` && request.method() === 'PUT') {
        const input = request.postDataJSON() as Record<string, unknown>
        payloads.push(input)
        await updateTeam(team.id, toTeamPatch(input))
        data = await getTeamById(team.id)
      } else if (url.includes('/line')) {
        data = { enabled: false, authenticated: false }
      } else {
        throw new Error(`Unexpected synthetic route: ${request.method()} ${url}`)
      }
      await route.fulfill({ json: { status: 'success', data } })
    })
    await page.goto(`${server.resolvedUrls!.local[0]}tests/team-provider-auth-settings-fixture.html`)
    const openDialog = async (name: string) => {
      await page.getByRole('button', { name: `แก้ไขทีม ${name}`, exact: true }).first().click()
      await page.getByRole('dialog').waitFor()
    }
    await openDialog('Empty session team')
    await page.fill(`#provider-email-admin-team-${team.id}`, 'fixture@example.test')
    await page.fill(`#provider-password-admin-team-${team.id}`, 'fixture-password')
    await page.getByRole('button', { name: 'เชื่อมต่อบัญชี', exact: true }).click()
    await page.getByText('เชื่อมต่อแล้ว', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'เชื่อมต่ออีกครั้ง', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'output/playwright/team-provider-auth/desktop-team-dialog-connected.png', fullPage: true, animations: 'disabled' })
    const connected = await getTeamProviderAuth(team.id)
    assert.ok(connected)
    await page.fill('#team-name', 'Unrelated settings saved')
    await page.getByRole('button', { name: 'บันทึกทีม', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await getTeamProviderAuth(team.id), connected, 'saving the actual initially empty Teams dialog must retain the newly connected account, pair and epoch')
    assert.equal('spxCookie' in payloads[0], false)
    assert.equal('spxDeviceId' in payloads[0], false)

    // A real legacy replacement still invalidates automatic credentials.
    await openDialog('Unrelated settings saved')
    await page.getByText('การเชื่อมต่อแบบเดิม (ขั้นสูง)', { exact: true }).click()
    await page.fill('#team-cookie', 'manual-cookie')
    await page.fill('#team-device', 'manual-device')
    await page.getByRole('button', { name: 'บันทึกทีม', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const replaced = await getTeamProviderAuth(team.id)
    assert.equal(replaced?.hasPassword, false)
    assert.equal(replaced?.cookie, 'manual-cookie')
    assert.equal(replaced?.deviceId, 'manual-device')
    assert.equal(replaced?.epoch, connected.epoch + 1)

    // Explicit clearing is also preserved, including only one edited field.
    await openDialog('Unrelated settings saved')
    await page.getByText('การเชื่อมต่อแบบเดิม (ขั้นสูง)', { exact: true }).click()
    await page.fill('#team-cookie', '')
    await page.getByRole('button', { name: 'บันทึกทีม', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const cleared = await getTeamProviderAuth(team.id)
    assert.equal(cleared?.cookie, '')
    assert.equal(cleared?.deviceId, 'manual-device')
    assert.equal(cleared?.epoch, connected.epoch + 2)
    assert.equal(payloads[2].spxCookie, '')
    assert.equal('spxDeviceId' in payloads[2], false)

    // Simulate a separate actor connecting while this empty-cookie snapshot is open.
    await openDialog('Unrelated settings saved')
    await connect()
    const externallyConnected = await getTeamProviderAuth(team.id)
    await page.getByRole('button', { name: 'บันทึกทีม', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await getTeamProviderAuth(team.id), externallyConnected, 'external connection must also survive stale settings save')
    console.log('frontend-team-provider-auth-settings: real dialog + controller payload + memory persistence regressions passed')
  } finally {
    await browser.close()
    await server.close()
    await closePool()
    resetMemoryDb()
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
