import { MetricsCollector, type MetricsSnapshot } from "../src/services/metrics.js";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { browserFixtureServerOptions } from "./browser-fixture-server.js";
declare global {
  interface Window {
    __metricsFixture: {
      emitPayload(snapshot: MetricsSnapshot): void;
      legacyPool(value: boolean): void;
      emit(teamId: number | null, paused?: boolean, canonical?: boolean): void;
      counts(): Record<string, number>;
      httpPaused(value: boolean): void;
      auth(id: number, teamId: number | null, role?: "user" | "admin"): void;
    };
  }
}
async function run() {
  const server = await createServer({
    configFile: false,
    envDir: false,
    root: process.cwd(),
    cacheDir: "node_modules/.vite-metrics-observation",
    optimizeDeps: { entries: ["tests/metrics-observation-fixture.html"] },
    plugins: [tailwindcss(), react()],
    server: await browserFixtureServerOptions(),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const base = server.resolvedUrls!.local[0];
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === new URL(base).origin
        ? route.continue()
        : route.abort(),
    );
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(120_000);
    page.on("pageerror", (error) => console.error("fixture-page-error", error));
    await page.clock.install();
    await page.goto(base + "tests/metrics-observation-fixture.html");
    await page.getByLabel("selected").filter({ hasText: "71:false:false" }).waitFor();
    await page.getByText("Shared process pool", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("95% pool reuse", { exact: true }).count(),
      0,
      "team view cannot claim team reuse from a process numerator",
    );
    await page.evaluate(() => window.__metricsFixture.emit(71, true, true));
    await page.getByLabel("selected").filter({ hasText: "71:true:true" }).waitFor();
    assert.equal(await page.getByLabel("bell").textContent(), "1");
    const initial = await page.evaluate(() => window.__metricsFixture.counts()["71"]);
    await page.clock.runFor(110_000);
    assert.equal(
      await page.evaluate(() => window.__metricsFixture.counts()["71"]),
      initial,
      "fresh SSE suppresses repeated polling in both mounted consumers",
    );
    await page.clock.runFor(15_001);
    await page.getByLabel("selected").filter({ hasText: "71:false:false" }).waitFor();
    assert.ok(
      (await page.evaluate(() => window.__metricsFixture.counts()["71"])) > initial,
      "silence enables HTTP fallback and discards stale SSE precedence",
    );
    await page.evaluate(() => window.__metricsFixture.emit(71, true));
    await page.getByLabel("selected").filter({ hasText: "71:true:true" }).waitFor();
    const recovered = await page.evaluate(() => window.__metricsFixture.counts()["71"]);
    await page.clock.runFor(30_000);
    assert.equal(await page.evaluate(() => window.__metricsFixture.counts()["71"]), recovered);
    await page.evaluate(() => window.__metricsFixture.auth(2, 72));
    await page.getByLabel("selected").filter({ hasText: "72:false:false" }).waitFor();
    await page.evaluate(() => window.__metricsFixture.emit(71, true));
    assert.ok(
      !(await page.getByLabel("selected").textContent())!.includes("71:"),
      "other team cannot be consumed",
    );
    await page.evaluate(() => window.__metricsFixture.emit(72, true, true));
    await page.getByLabel("selected").filter({ hasText: "72:true:true" }).waitFor();
    await page.evaluate(() => window.__metricsFixture.auth(3, null, "admin"));
    await page.getByLabel("selected").filter({ hasText: "null:false:false" }).waitFor();
    await page.evaluate(() => window.__metricsFixture.emit(72, true, true));
    await page.getByLabel("selected").filter({ hasText: "null:false:false" }).waitFor();
    await page.evaluate(() => window.__metricsFixture.emit(null, true, true));
    await page.getByLabel("selected").filter({ hasText: "null:true:true" }).waitFor();
    await page.getByText("95% pool reuse", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.__metricsFixture.legacyPool(true);
      window.__metricsFixture.emit(null, true, true);
    });
    await page.getByText("Pool ownership unknown", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("95% pool reuse", { exact: true }).count(),
      0,
      "legacy pool ownership must not produce a reuse claim",
    );
    await page.evaluate(() => {
      window.__metricsFixture.legacyPool(false);
      window.__metricsFixture.emit(null, true, true);
    });
    await page.getByText("95% pool reuse", { exact: true }).waitFor();
    await page.getByText("42 ms · p95 42 ms", { exact: true }).waitFor();
    assert.equal(await page.getByText("ยังไม่มีข้อมูลสังเกต", { exact: true }).count(), 3);
    assert.equal(await page.locator("ol > li").count(), 9, "primary timeline remains nine stages");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    mkdirSync("output/playwright/metrics-observation", { recursive: true });
    await page.screenshot({
      path: "output/playwright/metrics-observation/mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: "output/playwright/metrics-observation/desktop.png",
      fullPage: true,
    });
    await page.evaluate(() => window.__metricsFixture.auth(4, null, "user"));
    await page.getByLabel("selected").filter({ hasText: "none" }).waitFor();
    await page.evaluate(() => window.__metricsFixture.emit(null, true, true));
    assert.equal(
      await page.getByLabel("selected").textContent(),
      "none",
      "unassigned user cannot consume admin aggregate",
    );
    await page.evaluate(() => window.__metricsFixture.auth(5, 73));
    await page.getByLabel("selected").filter({ hasText: "73:false:false" }).waitFor();
    const poll = new MetricsCollector({ teamId: 73 });
    poll.recordPoll(10, true, "ok", 1);
    const merged = poll.snapshot();
    await page.evaluate((snapshot) => window.__metricsFixture.emitPayload(snapshot), merged);
    await page.getByLabel("selected").filter({ hasText: "73:false:true" }).waitFor();
    assert.equal(await page.getByText("ยังไม่มีข้อมูลสังเกต", { exact: true }).count(), 4, "current production metrics without A3 stage observations remain usable");
    console.log(
      "metrics-observation-browser: mounted SSE silence/recovery, auth/team/admin isolation, bell/shared selection and compact rendering passed",
    );
  } finally {
    await browser.close();
    await server.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
