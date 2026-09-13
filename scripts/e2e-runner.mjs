import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

export const e2eSuites = [
  { name: "Admin UI", file: "tests/admin-ui-e2e.test.ts" },
  { name: "User UI", file: "tests/user-ui-e2e.test.ts" },
];
export function buildE2eEnv(baseEnv = process.env) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "HOME"]) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return { ...env, RUN_E2E: "true", E2E_HEADLESS: baseEnv.E2E_HEADLESS ?? "true",
    NODE_ENV: "test", DB_MODE: "memory", SPX_TEST_SKIP_ENV_FILE: "1", HTTP_ENABLED: "true",
    JWT_SECRET: "synthetic-e2e-jwt-secret-at-least-32-characters",
    COOKIE_SECRET: "synthetic-e2e-cookie-secret-at-least-32-characters",
    SECRETS_KEY: "synthetic-e2e-encryption-key-at-least-32-characters",
    API_URL: "http://127.0.0.1:1/booking/bidding/list", REFERER: "http://127.0.0.1:1", APP_NAME: "SPX synthetic E2E",
    AUTO_ACCEPT_ENABLED: "false", LINE_ENABLED: "false", DISCORD_ENABLED: "false", LINE_BOT_ENABLED: "false",
  };
}
export function runE2eSuite(repoRoot, suite, env = buildE2eEnv(), spawn = spawnSync) {
  return spawn(process.execPath, ["--import", "tsx", suite.file], { stdio: "inherit", cwd: repoRoot, env, timeout: 240_000, killSignal: "SIGKILL" });
}
export function runE2e(repoRoot, { spawn = spawnSync, browserAvailable = () => existsSync(chromium.executablePath()), env = buildE2eEnv() } = {}) {
  if (!browserAvailable()) {
    console.error("Chromium is missing. Install it explicitly once: npx playwright install chromium");
    return 1;
  }
  const build = spawn(process.execPath, [join(repoRoot, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: repoRoot, env: { ...env, NODE_ENV: "production" }, stdio: "inherit", timeout: 180_000, killSignal: "SIGKILL",
  });
  if (build.status !== 0 || build.error || build.signal) { console.error("Fresh frontend build failed", build.error?.code, build.status, build.signal); return build.status || 1; }
  for (const suite of e2eSuites) {
    console.log(`Running ${suite.name}: DB_MODE=memory; env-file loading disabled; deadline=240000ms`);
    const result = runE2eSuite(repoRoot, suite, env, spawn);
    if (result.status !== 0 || result.error || result.signal) { console.error(`${suite.name} failed`, result.error?.code, result.status, result.signal); return result.status || 1; }
  }
  return 0;
}
