import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Nest under this checkout only for installed tsx resolution; every child file
// and synthetic env belongs to this fixture, and the runner never sees .env.
const fixture = mkdtempSync(join(resolve("tests"), ".runner-env-fixture-"));
try {
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "tests"));
  copyFileSync(resolve("scripts/run-tests.mjs"), join(fixture, "scripts/run-tests.mjs"));
  writeFileSync(join(fixture, ".env"), "SECRETS_KEY=synthetic-file-value-must-not-load\n");
  writeFileSync(join(fixture, "tests/isolation.test.ts"), `
    import assert from 'node:assert/strict';
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.DB_MODE, 'memory');
    assert.equal(process.env.SPX_TEST_SKIP_ENV_FILE, '1');
    assert.equal(process.env.SECRETS_KEY, 'synthetic-standalone-test-key-32-characters');
    console.log('actual child isolation passed');
  `);
  const env = Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"].map((key) => [key, process.env[key]]));
  const result = spawnSync(process.execPath, [join(fixture, "scripts/run-tests.mjs"), "isolation"], { cwd: fixture, encoding: "utf8", timeout: 20_000, env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /actual child isolation passed/);
  console.log("standard runner actual child uses synthetic env-file opt-out and encryption key");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
