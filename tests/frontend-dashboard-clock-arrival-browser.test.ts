import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'
import { browserFixtureServerOptions } from './browser-fixture-server.js'

declare global {
  interface Window {
    __dashboardClockFixture: { publish(timestamp: number): void }
    __dashboardClockTick: number
  }
}

async function run() {
  // Extend only the existing test fixture in memory; production Dashboard and its
  // helper are loaded unchanged. The receipt proves each new query value rendered.
  const server = await createServer({
    configFile: false,
    envDir: false,
    root: process.cwd(),
    cacheDir: 'node_modules/.vite-dashboard-clock-arrival-tests',
    optimizeDeps: { entries: ['tests/dashboard-runtime-fixture.html'] },
    plugins: [
      {
        name: 'dashboard-clock-arrival-fixture',
        enforce: 'pre',
        transform(source, id) {
          if (!id.replaceAll('\\', '/').endsWith('/tests/dashboard-runtime-fixture.tsx')) return
          return source
            .replace('QueryClient, QueryClientProvider', 'QueryClient, QueryClientProvider, useQuery')
            .replace('<DashboardComponent />', '<DashboardComponent /><DashboardClockReceipt />')
            + `
function DashboardClockReceipt() {
  const { data } = useQuery({ queryKey: ['metrics', user.id, user.role, user.teamId], queryFn: () => currentMetricsResponse });
  return <output aria-label="Rendered poll timestamp">{data?.lastPoll.timestamp}</output>;
}
Object.assign(window, {
  __dashboardClockFixture: {
    publish(timestamp: number) {
      currentMetricsResponse = metrics({ timestamp: new Date(timestamp).toISOString() });
      queryClient.setQueryData(['metrics', user.id, user.role, user.teamId], currentMetricsResponse);
    },
  },
});
`
        },
      },
      tailwindcss(),
      react(),
    ],
    server: await browserFixtureServerOptions(),
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    browser = await chromium.launch({ headless: true })
    await server.listen()
    const baseUrl = server.resolvedUrls?.local[0]
    assert.ok(baseUrl)
    const fixtureOrigin = new URL(baseUrl).origin
    const page = await browser.newPage()
    const externalRequests: string[] = []
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === fixtureOrigin) return route.continue()
      externalRequests.push(route.request().url())
      return route.abort()
    })
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(120_000)
    const initialTime = Date.parse('2026-09-13T07:00:00.000Z')
    await page.clock.install({ time: initialTime })
    await page.addInitScript(() => {
      const originalSetInterval = window.setInterval.bind(window)
      window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay !== 5_000 || typeof callback !== 'function') return originalSetInterval(callback, delay, ...args)
        return originalSetInterval(() => {
          window.__dashboardClockTick = Date.now()
          callback(...args)
        }, delay)
      }) as typeof window.setInterval
    })
    await page.goto(`${baseUrl}tests/dashboard-runtime-fixture.html`)
    await page.getByText('Live', { exact: true }).waitFor()
    await page.clock.pauseAt(initialTime + 60_000)
    await page.clock.runFor(5_001)
    const { tick, now } = await page.evaluate(() => ({ tick: window.__dashboardClockTick, now: Date.now() }))
    assert.ok(Number.isFinite(tick), 'the mounted dashboard presentation timer has ticked')
    assert.ok(now - tick < 1_100, 'the test starts close to the presentation tick')

    const publish = async (timestamp: number) => {
      await page.evaluate((value) => window.__dashboardClockFixture.publish(value), timestamp)
      await page.clock.runFor(20)
      await page.getByRole('status', { name: 'Rendered poll timestamp', exact: true })
        .getByText(new Date(timestamp).toISOString(), { exact: true }).waitFor()
    }
    const assertLive = async (message: string) => {
      assert.equal(await page.getByText('Live', { exact: true }).count(), 1, message)
      assert.equal(await page.getByText('Unknown', { exact: true }).count(), 0, message)
      assert.equal(await page.getByText('บัญชีผู้ให้บริการ: ปกติ', { exact: true }).count(), 1, message)
    }

    // A real poll at T+1000 arrives at T+1100, before the next T+5000 tick.
    await page.clock.runFor(tick + 1_100 - now)
    await publish(tick + 1_000)
    await assertLive('a valid newly received poll between clock ticks must immediately remain Live/healthy')
    for (const arrivalOffset of [1_400, 1_700, 2_000, 2_300]) {
      const currentTime = await page.evaluate(() => Date.now())
      await page.clock.runFor(tick + arrivalOffset - currentTime)
      await publish(tick + arrivalOffset - 100)
      await assertLive(`repeated arrival at T+${arrivalOffset} must remain Live/healthy`)
    }
    assert.equal(await page.evaluate(() => window.__dashboardClockTick), tick, 'all arrivals precede the next presentation tick')

    const receiptTime = await page.evaluate(() => Date.now())
    await publish(receiptTime + 60_000)
    assert.equal(await page.getByText('Unknown', { exact: true }).count(), 1, 'a genuinely future poll remains Unknown')
    assert.equal(await page.getByText('บัญชีผู้ให้บริการ: ยังไม่ยืนยัน', { exact: true }).count(), 1)

    await publish(receiptTime - 120_001)
    assert.equal(await page.getByText('Stale', { exact: true }).count(), 1, 'old observations remain Stale')

    const freshTime = await page.evaluate(() => Date.now())
    await publish(freshTime)
    await assertLive('fresh data recovers immediately')
    await page.clock.runFor(125_001)
    assert.equal(await page.getByText('Stale', { exact: true }).count(), 1, 'the presentation timer ages an unchanged poll during silence')
    assert.equal(await page.getByText('บัญชีผู้ให้บริการ: ล่าสุดปกติ (ข้อมูลเก่า)', { exact: true }).count(), 1)
    assert.deepEqual(externalRequests, [], 'the mounted regression stays on the loopback fixture')
    console.log('frontend-dashboard-clock-arrival-browser: immediate/repeated arrivals, true future rejection, old data and silent aging passed')
  } finally {
    await browser?.close()
    await server.close()
  }
}

void run()
