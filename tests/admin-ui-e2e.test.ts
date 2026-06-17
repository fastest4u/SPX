// E2E test for admin UI flows using Playwright.
// Guard: Only runs if process.env.RUN_E2E === "true".
if (process.env.RUN_E2E !== "true") {
  console.log("Skipping E2E test (RUN_E2E not set to 'true').");
  process.exit(0);
}

// Set required environments before importing app configurations
process.env.NODE_ENV = "test";
process.env.DB_MODE = "memory";
process.env.HTTP_ENABLED = "true";
process.env.HTTP_PORT = "3012";
process.env.JWT_SECRET = "jwt-secret-must-be-long-enough-32-chars-at-least";
process.env.COOKIE_SECRET = "cookie-secret-must-be-long-enough-32-chars-at-least";
process.env.ADMIN_PASSWORD = "admin-password-must-be-long-enough-12-chars";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_ROLE = "admin";
process.env.API_URL = "http://localhost:3012/booking/bidding/list";
process.env.APP_NAME = "SPX E2E Test App";
process.env.REFERER = "http://localhost:3012";

import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startHttpServer, stopHttpServer } from "../src/services/http-server.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { createTeam } from "../src/repositories/team-repository.js";
import { createAdminUserIfNotExists } from "../src/repositories/user-repository.js";

// ─── Viewport Profiles ────────────────────────────────────────────────────────
const VIEWPORTS = [
  { name: "Desktop HD",  width: 1440, height: 900 },
  { name: "Laptop",      width: 1280, height: 720 },
  { name: "Tablet",      width: 768,  height: 1024 },
  { name: "Mobile L",    width: 414,  height: 896 },
  { name: "Mobile S",    width: 375,  height: 667 },
];

// ─── Pages to Verify (path → expected heading text) ──────────────────────────
const PAGES_TO_VERIFY: { path: string; label: string; selector: string }[] = [
  { path: "/",                      label: "Dashboard",              selector: "text=รายการค้นหา" },
  { path: "/history",               label: "ประวัติงาน",              selector: "text=ประวัติงาน" },
  { path: "/notifications",         label: "แจ้งเตือน",              selector: "text=แจ้งเตือน" },
  { path: "/line-bot",              label: "LINE Bot",               selector: "text=LINE Bot" },
  { path: "/line-image-extractions",label: "LINE Runsheets",         selector: "text=LINE Runsheets" },
  { path: "/reports",               label: "รายงาน",                 selector: "text=รายงาน" },
  { path: "/auto-accept-history",   label: "ประวัติรับงานอัตโนมัติ", selector: "text=ประวัติรับงาน" },
  { path: "/audit",                 label: "ประวัติการใช้งาน",       selector: "text=ประวัติการใช้งาน" },
  { path: "/teams",                 label: "จัดการทีม",              selector: "text=จัดการทีม" },
  { path: "/users",                 label: "จัดการผู้ใช้",           selector: "text=เพิ่มผู้ใช้" },
  { path: "/settings",              label: "ตั้งค่าระบบ",            selector: "text=ตั้งค่า" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function banner(msg: string) {
  const line = "─".repeat(60);
  console.log(`\n${line}\n  ${msg}\n${line}`);
}

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

// Inject localStorage flag to suppress Coachmark dialog before any page load
async function suppressCoachmark(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('spx:coachmark:v1', '1');
  });
}

async function setupMocks(page: Page) {
  await page.route("**/api/line-bot/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "success",
        data: { enabled: true, authenticated: true, sessionKey: "default", device: "IOSIPAD" },
      }),
    })
  );

  await page.route("**/api/line-bot/groups", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "success",
        data: { chats: [{ chatMid: "c1234567890", chatName: "E2E Test Group" }] },
      }),
    })
  );
}

async function login(page: Page) {
  await page.goto("http://localhost:3012/login");
  await page.fill("#login-username", "admin");
  await page.fill("#login-password", "admin-password-123");
  await page.click("button[type='submit']");
  await page.waitForURL("http://localhost:3012/");
  ok("Logged in as admin");
}

// ─── Test 1: CRUD Flows (Desktop 1280×720) ────────────────────────────────────
async function testCrudFlows(browser: Browser) {
  banner("TEST 1 — Full Admin CRUD Flows  [1280×720 Desktop]");

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await suppressCoachmark(context);
  const page = await context.newPage();
  await setupMocks(page);

  try {
    // Login
    await login(page);

    const h1 = await page.textContent("h1");
    assert.ok(h1?.includes("ภาพรวมระบบ") || h1?.includes("SPX"), `Expected dashboard h1, got "${h1}"`);
    ok(`Dashboard header visible: "${h1}"`);

    // ── Teams CRUD ──────────────────────────────────────────────────────────
    console.log("\n  [Teams]");
    await page.goto("http://localhost:3012/teams");
    await page.waitForSelector("text=Default Team");
    ok("Teams page loaded — Default Team present");

    await page.click("text=เพิ่มทีม");
    await page.waitForSelector("text=เพิ่มทีมใหม่");
    await page.fill("#team-name", "Beta Ops Team");
    await page.fill("#team-cookie", "fms_user_id=123; session=abc;");
    await page.fill("#team-device", "my-device-id-xyz");
    await page.selectOption("#team-line", "c1234567890");
    await page.click("form button[type='submit']");
    await page.waitForSelector("text=Beta Ops Team");
    ok("Team created: Beta Ops Team");

    await page.click('button[title="แก้ไขทีม Beta Ops Team"]');
    await page.waitForSelector("text=แก้ไขทีม");
    await page.fill("#team-name", "Beta Ops Team Edited");
    await page.selectOption("#team-line", "c1234567890"); // re-select to satisfy form validation
    await page.click("form button[type='submit']");
    await page.waitForSelector("text=Beta Ops Team Edited");
    ok("Team edited: Beta Ops Team → Beta Ops Team Edited");

    // ── Rules CRUD ──────────────────────────────────────────────────────────
    console.log("\n  [Rules]");
    await page.goto("http://localhost:3012/");
    await page.waitForSelector("text=รายการค้นหา");

    await page.click("text=เพิ่มรายการ");
    await page.waitForSelector("text=เพิ่มรายการค้นหาใหม่");
    await page.fill("#create-name", "Suvarnabhumi 6W");
    await page.selectOption("#create-team", { label: "Beta Ops Team Edited" });
    await page.fill("#create-origins", "NERC-B");
    await page.fill("#create-destinations", "SOCE");
    await page.click("#create-vehicle_types");
    await page.click("text=6WH-6ล้อ[7.2m]");
    await page.click("#create-vehicle_types");
    await page.fill("#create-need", "2");
    await page.check("#create-accept-all");
    await page.click("text=สร้างรายการ");
    await page.waitForSelector("text=Suvarnabhumi 6W");
    ok("Rule created: Suvarnabhumi 6W");

    // ── Users CRUD ──────────────────────────────────────────────────────────
    console.log("\n  [Users]");
    await page.goto("http://localhost:3012/users");
    // Wait for the page to fully load (the "เพิ่มผู้ใช้" button in header)
    await page.getByRole("button", { name: "เพิ่มผู้ใช้" }).waitFor({ state: "visible" });

    // Click the exact button (subtitle also contains "เพิ่มผู้ใช้ใหม่" so must use role)
    await page.getByRole("button", { name: "เพิ่มผู้ใช้" }).click();

    // Wait for dialog role (not text which exists in subtitle already)
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 8_000 });
    await page.locator("[role='dialog'] #create-user-username").waitFor({ state: "visible" });

    await page.fill("#create-user-username", "new-operator");
    await page.fill("#create-user-password", "operator-password-123");
    await page.selectOption("#create-user-role", "user");
    // Select first available team by numeric value
    const firstTeamValue = await page.locator("#create-user-team option:not([value=''])").first().getAttribute("value");
    if (firstTeamValue) await page.selectOption("#create-user-team", firstTeamValue);

    await page.getByRole("dialog").locator("button[type='submit']").click();
    await page.waitForSelector("text=new-operator");
    ok("Operator user created: new-operator");



    // ── Read-only Admin Pages ────────────────────────────────────────────────
    console.log("\n  [Audit & Reports]");
    await page.goto("http://localhost:3012/audit");
    await page.waitForSelector("text=ประวัติการใช้งาน");
    ok("Audit Logs page loaded");

    await page.goto("http://localhost:3012/auto-accept-history");
    await page.waitForSelector("text=ประวัติรับงาน");
    ok("Auto-Accept History page loaded");

    await page.goto("http://localhost:3012/reports");
    await page.waitForSelector("text=รายงาน");
    ok("Reports page loaded");

    await page.goto("http://localhost:3012/notifications");
    await page.waitForSelector("text=แจ้งเตือน");
    ok("Notifications page loaded");

    await page.goto("http://localhost:3012/line-bot");
    await page.waitForSelector("text=LINE Bot");
    ok("LINE Bot page loaded");

    await page.goto("http://localhost:3012/history");
    await page.waitForSelector("text=ประวัติงาน");
    ok("History page loaded");

    await page.goto("http://localhost:3012/settings");
    await page.waitForSelector("text=ตั้งค่า");
    ok("Settings page loaded");

    console.log("\n  ✅ TEST 1 PASSED — All CRUD flows complete");
  } finally {
    await context.close();
  }
}

// ─── Test 2: Responsive Design — All Pages × All Viewports ───────────────────
async function testResponsiveDesign(browser: Browser) {
  banner("TEST 2 — Responsive Web Design  [All Pages × All Viewports]");

  const results: { viewport: string; page: string; passed: boolean; note?: string }[] = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n  📐 Viewport: ${vp.name} (${vp.width}×${vp.height})`);

    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    await suppressCoachmark(context);
    const page = await context.newPage();
    await setupMocks(page);

    // Login once per viewport
    await login(page);

    const isMobile = vp.width < 1024;

    // Get a login cookie for this context by logging in once on a temp page
    const loginPage = await context.newPage();
    await setupMocks(loginPage);
    await login(loginPage);
    await loginPage.close();

    for (const route of PAGES_TO_VERIFY) {
      // Fresh page per route to prevent SSE connection buildup slowing later pages
      const page = await context.newPage();
      await setupMocks(page);
      try {
        await page.goto(`http://localhost:3012${route.path}`, { timeout: 15_000, waitUntil: "domcontentloaded" });
        await page.waitForSelector(route.selector, { timeout: 12_000 });

        // ── Responsive-specific assertions ────────────────────────────────
        // Sidebar uses 'max-lg:-translate-x-full' (CSS transform, NOT display:none)
        // so we must check its x position, not visibility
        const sidebarLeft = await page.locator("aside").first().evaluate(
          (el) => el.getBoundingClientRect().left
        ).catch(() => 0);
        const sidebarOnScreen = sidebarLeft >= -10; // allow 10px tolerance

        if (isMobile) {
          // Sidebar must be translated off-screen (left < 0) on mobile
          assert.ok(!sidebarOnScreen,
            `${route.label}: desktop sidebar should be off-screen at ${vp.width}px (left=${sidebarLeft.toFixed(0)})`);

          // Mobile bottom tab bar must be visible
          const bottomNavVisible = await page.locator("nav.lg\\:hidden").isVisible().catch(() => false);
          assert.ok(bottomNavVisible,
            `${route.label}: mobile bottom-nav should be visible at ${vp.width}px`);
        } else {
          // Sidebar must be on-screen on desktop
          assert.ok(sidebarOnScreen,
            `${route.label}: sidebar should be on-screen at ${vp.width}px (left=${sidebarLeft.toFixed(0)})`);

          // Mobile bottom nav must be hidden on desktop (CSS hides with lg:hidden)
          const bottomNavVisible = await page.locator("nav.lg\\:hidden").isVisible().catch(() => false);
          assert.ok(!bottomNavVisible,
            `${route.label}: mobile bottom-nav should be hidden at ${vp.width}px`);
        }

        // Content should not overflow horizontally
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.ok(!overflow, `${route.label}: horizontal overflow detected at ${vp.width}px`);


        ok(`${vp.name} — ${route.label}`);
        results.push({ viewport: vp.name, page: route.label, passed: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${vp.name} — ${route.label}: ${msg}`);
        results.push({ viewport: vp.name, page: route.label, passed: false, note: msg });
      } finally {
        await page.close();
      }
    }

    await context.close();
  }

  // ── Summary Table ──────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);

  banner(`RESPONSIVE RESULTS — ${passed}/${total} passed`);

  // Print table header
  console.log(
    "  " +
    "Viewport".padEnd(14) +
    "Page".padEnd(26) +
    "Result"
  );
  console.log("  " + "─".repeat(52));
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log("  " + icon + " " + r.viewport.padEnd(13) + r.page.padEnd(26) + (r.passed ? "PASS" : `FAIL: ${r.note?.slice(0, 40)}`));
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} responsive checks failed`);
  }

  console.log("\n  ✅ TEST 2 PASSED — All pages are responsive across all viewports");
}

// ─── Main Runner ──────────────────────────────────────────────────────────────
async function run() {
  const HEADLESS = process.env.E2E_HEADLESS === "true"; // default: visible (false)

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  SPX Admin UI — E2E Browser Automation");
  console.log("  Headless:", HEADLESS ? "yes (background)" : "no (visible)");
  console.log("════════════════════════════════════════════════════════════\n");

  // Prepare in-memory DB
  console.log("🗄️  Preparing E2E memory database...");
  resetMemoryDb();
  await createTeam({
    name: "Default Team",
    enabled: true,
    spxCookie: "test-cookie",
    spxDeviceId: "test-device-id",
    lineGroupId: "c1234567890",
  });
  await createAdminUserIfNotExists("admin", "admin-password-123", "admin");
  console.log("   ✓ DB seeded\n");

  // Start server
  console.log("🚀 Starting HTTP Server on port 3012...");
  await startHttpServer(3012);
  console.log("   ✓ Server ready\n");

  // Launch browser (visible by default)
  console.log("🌐 Launching Chromium browser...");
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 200, // 200ms between actions when visible so user can watch
  });
  console.log("   ✓ Browser launched\n");

  let exitCode = 0;

  try {
    await testCrudFlows(browser);
    await testResponsiveDesign(browser);

    banner("🎉 ALL E2E TESTS PASSED");
  } catch (error) {
    console.error("\n❌ E2E test suite failed:", error);
    exitCode = 1;
  } finally {
    console.log("\n🔒 Closing browser...");
    await browser.close();

    console.log("🛑 Stopping HTTP server...");
    await stopHttpServer();

    process.exitCode = exitCode;
  }
}

run().catch((error) => {
  console.error("E2E Runner critical failure:", error);
  process.exit(1);
});
