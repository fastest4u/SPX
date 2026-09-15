import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const ownedFixture = mkdtempSync(join(tmpdir(), "spx-gate6-runtime-config-"));
process.on("exit", () => rmSync(ownedFixture, { recursive: true, force: true }));
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxRegisterUrl = pathToFileURL(require.resolve("tsx")).href;
const envModuleUrl = pathToFileURL(resolve(process.cwd(), "src/config/env.ts")).href;
const passthrough = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"];

function validate(overrides: Record<string, string>) {
  const childEnv: Record<string, string> = {
    NODE_ENV: "production",
    SPX_ROLE: "gate6-control",
    SPX_NODE_ID: "prod-gate6-control-1",
    HTTP_ENABLED: "true",
    HTTP_PORT: "3006",
    DB_MODE: "mysql",
    DB_HOST: "mysql.example.test",
    DB_PORT: "3306",
    DB_NAME: "SPX",
    DB_USERNAME: "spx_gate6_control",
    DB_PASSWORD: "database-password-value",
    DB_SSL_MODE: "verify-identity",
    DB_SSL_CA_FILE: "/run/config/db-ca.pem",
    DB_SSL_SERVERNAME: "mysql.example.test",
    GATE6_REPOSITORY: "owner/SPX",
    GATE6_LINE_NODE_SECRETS: `prod-line-service-1=${"l".repeat(32)}`,
    GATE6_OCR_NODE_SECRETS: `prod-ocr-service-1=${"o".repeat(32)}`,
    ...overrides,
  };
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  const script = `
    const mod = await import(${JSON.stringify(envModuleUrl)});
    try { mod.validateRuntimeConfig(); console.log("VALID"); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(42); }
  `;
  return spawnSync(process.execPath, ["--import", tsxRegisterUrl, "-e", script], {
    cwd: ownedFixture,
    encoding: "utf8",
    env: childEnv,
  });
}

const valid = validate({});
assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
assert.match(valid.stdout, /VALID/);

for (const [overrides, expected] of [
  [{ HTTP_ENABLED: "false" }, /requires HTTP_ENABLED=true/],
  [{ GATE6_REPOSITORY: "" }, /GATE6_REPOSITORY/],
  [{ GATE6_LINE_NODE_SECRETS: "" }, /GATE6_LINE_NODE_SECRETS/],
  [{ GATE6_OCR_NODE_SECRETS: "" }, /GATE6_OCR_NODE_SECRETS/],
  [{
    GATE6_LINE_NODE_SECRETS: `shared-node=${"l".repeat(32)}`,
    GATE6_OCR_NODE_SECRETS: `shared-node=${"o".repeat(32)}`,
  }, /identities must be disjoint/],
  [{
    GATE6_LINE_NODE_SECRETS: `prod-line-service-1=${"s".repeat(32)}`,
    GATE6_OCR_NODE_SECRETS: `prod-ocr-service-1=${"s".repeat(32)}`,
  }, /secrets must be distinct/],
] as Array<[Record<string, string>, RegExp]>) {
  const result = validate(overrides);
  assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, expected);
}

console.log("gate6 runtime config tests passed");
