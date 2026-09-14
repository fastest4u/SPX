import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "spx-frozen-migration-"));
const script = resolve("src/scripts/generate-migration.ts");
const tsx = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
try {
  const migrations = join(root, "migrations");
  mkdirSync(migrations);
  const baseline = join(migrations, "001_create_booking_requests.sql");
  const releasedBytes = Buffer.from("-- synthetic already-released migration\nSELECT 1;\n");
  writeFileSync(baseline, releasedBytes);
  const result = spawnSync(process.execPath, ["--import", tsx, script], {
    cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DB_MODE: "memory" },
  });
  assert.notEqual(result.status, 0, "generator must refuse to replace an existing migration");
  assert.deepEqual(readFileSync(baseline), releasedBytes, "released SQL bytes must remain immutable");
  assert.match(result.stderr, /existing migration|EEXIST/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("Migration generator refuses to overwrite released bytes");
