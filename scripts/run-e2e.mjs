import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

console.log("Installing Playwright Chromium browser binary...");
const installResult = spawnSync(
  process.platform === "win32" ? "cmd.exe" : "npx",
  process.platform === "win32" ? ["/d", "/s", "/c", "npx playwright install chromium"] : ["playwright", "install", "chromium"],
  { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" }
);

if (installResult.status !== 0) {
  console.error("Failed to install Playwright Chromium binary.");
  process.exit(installResult.status ?? 1);
}

console.log("Running E2E tests...");
const testResult = spawnSync(
  process.platform === "win32" ? "cmd.exe" : "npx",
  process.platform === "win32" ? ["/d", "/s", "/c", "npx tsx tests/admin-ui-e2e.test.ts"] : ["tsx", "tests/admin-ui-e2e.test.ts"],
  {
    stdio: "inherit",
    cwd: repoRoot,
    shell: process.platform === "win32",
    env: { ...process.env, RUN_E2E: "true" }
  }
);

process.exit(testResult.status ?? 0);
