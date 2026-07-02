import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eEnv, e2eSuites, installChromium, runE2eSuite } from "./e2e-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

console.log("Installing Playwright Chromium browser binary...");
const installResult = installChromium(repoRoot);

if (installResult.status !== 0) {
  console.error("Failed to install Playwright Chromium binary.");
  process.exit(installResult.status ?? 1);
}

console.log("Running E2E tests...");
const env = buildE2eEnv(process.env);

for (const suite of e2eSuites) {
  console.log(`\n=== ${suite.name} ===`);
  const testResult = runE2eSuite(repoRoot, suite, env);
  if (testResult.status !== 0) {
    console.error(`${suite.name} E2E suite failed.`);
    process.exit(testResult.status ?? 1);
  }
}

process.exit(0);
