import { spawnSync } from "node:child_process";

export const e2eSuites = [
  { name: "Admin UI", file: "tests/admin-ui-e2e.test.ts" },
  { name: "User UI", file: "tests/user-ui-e2e.test.ts" },
];

export function buildE2eEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    RUN_E2E: "true",
    E2E_HEADLESS: baseEnv.E2E_HEADLESS ?? "true",
  };
}

function runNpx(args, options) {
  return spawnSync(
    process.platform === "win32" ? "cmd.exe" : "npx",
    process.platform === "win32" ? ["/d", "/s", "/c", `npx ${args.join(" ")}`] : args,
    { ...options, shell: process.platform === "win32" },
  );
}

export function installChromium(repoRoot) {
  return runNpx(["playwright", "install", "chromium"], {
    stdio: "inherit",
    cwd: repoRoot,
  });
}

export function runE2eSuite(repoRoot, suite, env = buildE2eEnv()) {
  return runNpx(["tsx", suite.file], {
    stdio: "inherit",
    cwd: repoRoot,
    env,
  });
}
