// E2E test for user UI flows using Playwright.
// Guard: Only runs if process.env.RUN_E2E === "true".
if (process.env.RUN_E2E !== "true") {
  console.log("Skipping E2E test (RUN_E2E not set to 'true').");
  process.exit(0);
}

// Set required environments before importing app configurations
process.env.NODE_ENV = "test";
process.env.DB_MODE = "memory";
process.env.HTTP_ENABLED = "true";
process.env.HTTP_PORT = "3013";
process.env.JWT_SECRET = "jwt-secret-must-be-long-enough-32-chars-at-least";
process.env.COOKIE_SECRET = "cookie-secret-must-be-long-enough-32-chars-at-least";
process.env.ADMIN_PASSWORD = "admin-password-must-be-long-enough-12-chars";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_ROLE = "admin";
process.env.API_URL = "http://localhost:3013/booking/bidding/list";
process.env.APP_NAME = "SPX E2E Test App";
process.env.REFERER = "http://localhost:3013";

import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startHttpServer, stopHttpServer } from "../src/services/http-server.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { createTeam } from "../src/repositories/team-repository.js";
import { createUser } from "../src/repositories/user-repository.js";

// ─── Viewport Profiles ────────────────────────────────────────────────────────
const VIEWPORTS = [
  { name: "Desktop HD",  width: 1440, height: 900 },
  { name: "Laptop",      width: 1280, height: 720 },
  { name: "Tablet",      width: 768,  height: 1024 },
  { name: "Mobile L",    width: 414,  height: 896 },
  { name: "Mobile S",    width: 375,  height: 667 },
];

// ─── Pages to Verify (path → expected heading/content text) ──────────────────
// Only pages that a standard user can access
const PAGES_TO_VERIFY: { path: string; label: string; selector: string }[] = [
  { path: "/",                      label: "Dashboard",              selector: "text=รายการค้นหา" },
  { path: "/history",               label: "ประวัติงาน",              selector: "text=ประวัติงาน" },
  { path: "/notifications",         label: "แจ้งเตือน",              selector: "text=แจ้งเตือน" },
  { path: "/line-bot",              label: "LINE Bot",               selector: "text=LINE Bot" },
  { path: "/line-image-extractions",label: "LINE Runsheets",         selector: "text=LINE Runsheets" },
  { path: "/reports",               label: "รายงาน",                 selector: "text=รายงาน" },
  { path: "/auto-accept-history",   label: "ประวัติรับงานอัตโนมัติ", selector: "text=ประวัติรับงาน" },
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
  await page.goto("http://localhost:3013/login");
  await page.fill("#login-username", "testuser");
  await page.fill("#login-password", "testuser-password-123");
  await page.click("button[type='submit']");
  await page.waitForURL("http://localhost:3013/");
  ok("Logged in as testuser (role: user)");
}

// ─── Test 1: User CRUD Flows (Desktop 1280×720) ──────────────────────────────
async function testUserCrudFlows(browser: Browser) {
  banner("TEST 1 — User CRUD Flows (Rules only) [1280×720 Desktop]");

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await suppressCoachmark(context);
  const page = await context.newPage();
  
  // Capture page logs
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

  await setupMocks(page);

  try {
    // Login
    await login(page);

    const h1 = await page.textContent("h1");
    assert.ok(h1?.includes("ภาพรวมระบบ") || h1?.includes("SPX"), `Expected dashboard h1, got "${h1}"`);
    ok(`Dashboard header visible: "${h1}"`);

    // ── Rules CRUD ──────────────────────────────────────────────────────────
    console.log("\n  [Rules CRUD]");
    await page.goto("http://localhost:3013/");
    await page.waitForSelector("text=รายการค้นหา");

    // Create Rule
    await page.click("text=เพิ่มรายการ");
    await page.waitForSelector("text=เพิ่มรายการค้นหาใหม่");
    
    // Verify team selection is NOT present for standard user
    const teamSelectPresent = await page.locator("#create-team").isVisible().catch(() => false);
    assert.ok(!teamSelectPresent, "Standard user should NOT see team selection in Create Rule dialog");
    
    // Verify accept-all option is NOT present for standard user
    const acceptAllPresent = await page.locator("#create-accept-all").isVisible().catch(() => false);
    assert.ok(!acceptAllPresent, "Standard user should NOT see accept-all toggle in Create Rule dialog");

    await page.fill("#create-name", "User Ops Rule");
    await page.fill("#create-origins", "NERC-A");
    await page.fill("#create-destinations", "SOCE");
    await page.click("#create-vehicle_types");
    await page.click("text=6WH-6ล้อ[7.2m]");
    await page.click("#create-vehicle_types");
    await page.fill("#create-need", "2");
    await page.click("text=สร้างรายการ");
    await page.waitForSelector("text=User Ops Rule");
    ok("Rule created: User Ops Rule");

    // Edit Rule
    const row = page.locator("tr", { hasText: "User Ops Rule" });
    await row.locator("text=แก้ไข").click();
    await page.waitForSelector("text=แก้ไขรายการค้นหา");

    // Verify team selection label / accept-all toggle are not editable or visible as input fields
    const editTeamSelectPresent = await page.locator("#edit-team").isVisible().catch(() => false);
    assert.ok(!editTeamSelectPresent, "Standard user should NOT see editable team selection in Edit Rule dialog");
    const editAcceptAllPresent = await page.locator("#accept-all").isVisible().catch(() => false);
    assert.ok(!editAcceptAllPresent, "Standard user should NOT see accept-all toggle in Edit Rule dialog");

    await page.fill("#name", "User Ops Rule Edited");
    await page.click("text=บันทึกการแก้ไข");
    await page.waitForSelector("text=User Ops Rule Edited");
    ok("Rule edited: User Ops Rule → User Ops Rule Edited");

    // Delete Rule
    const editedRow = page.locator("tr", { hasText: "User Ops Rule Edited" });
    await editedRow.locator("text=ลบ").click();
    await page.waitForSelector("text=ยืนยันการลบ");
    await page.getByRole("dialog").getByRole("button", { name: "ลบรายการ" }).click();
    
    // Wait for the rule row to disappear from the page
    const deletedRow = page.locator("tr", { hasText: "User Ops Rule Edited" });
    await deletedRow.waitFor({ state: "detached" });
    ok("Rule deleted: User Ops Rule Edited");

    // ── Admin Redirects ──────────────────────────────────────────────────────
    console.log("\n  [Admin Redirects]");
    const adminPaths = ["/users", "/teams", "/settings", "/audit"];
    for (const path of adminPaths) {
      await page.goto(`http://localhost:3013${path}`);
      await page.waitForURL("http://localhost:3013/");
      ok(`Redirected from admin path ${path} to /`);
    }

    console.log("\n  ✅ TEST 1 PASSED — User CRUD and Admin redirects verified");
  } finally {
    await context.close();
  }
}

// ─── Test 2: Responsive Design — All User Pages × All Viewports ──────────────
async function testResponsiveDesign(browser: Browser) {
  banner("TEST 2 — Responsive Web Design [User Pages × All Viewports]");

  const results: { viewport: string; page: string; passed: boolean; note?: string }[] = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n  📐 Viewport: ${vp.name} (${vp.width}×${vp.height})`);

    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    await suppressCoachmark(context);
    
    // Get a login cookie for this context by logging in once on a temp page
    const loginPage = await context.newPage();
    await setupMocks(loginPage);
    await login(loginPage);
    await loginPage.close();

    const isMobile = vp.width < 1024;

    for (const route of PAGES_TO_VERIFY) {
      // Fresh page per route to prevent SSE connection buildup
      const page = await context.newPage();
      await setupMocks(page);
      try {
        await page.goto(`http://localhost:3013${route.path}`, { timeout: 15_000, waitUntil: "domcontentloaded" });
        await page.waitForSelector(route.selector, { timeout: 12_000 });

        // ── Responsive-specific assertions ────────────────────────────────
        // Sidebar uses 'max-lg:-translate-x-full' (CSS transform, NOT display:none)
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

          // Mobile bottom nav must be hidden on desktop
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

  console.log("\n  ✅ TEST 2 PASSED — All user pages are responsive across all viewports");
}

// ─── Main Runner ──────────────────────────────────────────────────────────────
async function run() {
  const HEADLESS = process.env.E2E_HEADLESS === "true"; // default: visible (false)

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  SPX User UI — E2E Browser Automation");
  console.log("  Headless:", HEADLESS ? "yes (background)" : "no (visible)");
  console.log("════════════════════════════════════════════════════════════\n");

  // Prepare in-memory DB
  console.log("🗄️  Preparing E2E memory database...");
  resetMemoryDb();
  const team = await createTeam({
    name: "Default Team",
    enabled: true,
    spxCookie: "test-cookie",
    spxDeviceId: "test-device-id",
    lineGroupId: "c1234567890",
  });
  await createUser("testuser", "testuser-password-123", "user", team.id);
  console.log("   ✓ DB seeded (testuser created in team ID:", team.id, ")\n");

  // Start server
  console.log("🚀 Starting HTTP Server on port 3013...");
  await startHttpServer(3013);
  console.log("   ✓ Server ready\n");

  // Launch browser (visible by default)
  console.log("🌐 Launching Chromium browser...");
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 200, // 200ms between actions when visible so user can watch live
  });
  console.log("   ✓ Browser launched\n");

  let exitCode = 0;

  try {
    await testUserCrudFlows(browser);
    await testResponsiveDesign(browser);

    banner("🎉 ALL USER E2E TESTS PASSED");
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
