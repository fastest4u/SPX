import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
function check(status: string, phase: string, success: number, failed: number) {
  const result = spawnSync(process.execPath, [resolve("scripts/service-fault-outbox-check.mjs"),
    `--fixture-json=${JSON.stringify([{ status, count: 1, attempted: 1, minAttempts: 1, maxAttempts: 1 }])}`,
    `--delivery-fixture-json=${JSON.stringify({ matchedOutboxRows: 1, success, failed })}`,
    `--delivery-phase=${phase}`, "--event-key-contains=synthetic-drill", "--min-total=1"], {
    encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DB_MODE: "memory" },
  });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}
const baseline = check("sent", "baseline", 1, 0);
assert.equal(baseline.summary.retriedRows, 0, "first successful provider attempt is not a retry");
assert.equal(baseline.summary.pending, 0);
const outage = check("delivery_ambiguous", "line-down", 0, 1);
assert.equal(outage.summary.pending, 1, "unresolved delivery remains pending operator reconciliation");
assert.equal(outage.summary.retriedRows, 1, "outage retains observed failed/ambiguous attempt");
console.log("Task9 evidence distinguishes first success from unresolved outage delivery");

const mixedGroup = spawnSync(process.execPath, [resolve("scripts/service-fault-outbox-check.mjs"),
  `--fixture-json=${JSON.stringify([{ status: "sent", count: 5, attempted: 5, retried: 2, minAttempts: 1, maxAttempts: 3 }])}`], {
  encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DB_MODE: "memory" },
});
assert.equal(mixedGroup.status, 0, mixedGroup.stdout || mixedGroup.stderr);
assert.equal(JSON.parse(mixedGroup.stdout).summary.retriedRows, 2, "use exact SQL retry count for mixed attempt groups");
