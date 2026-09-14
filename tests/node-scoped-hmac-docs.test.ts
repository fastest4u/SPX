import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const example = read(".env.example");
const reference = read("docs/env-reference.md");
const deployment = read("docs/deployment-a3.md");

for (const key of [
  "NOTIFICATION_NODE_SECRET",
  "NOTIFICATION_NODE_SECRETS",
  "NOTIFICATION_ALLOWED_NODE_TEAMS",
  "OCR_NODE_SECRET",
  "OCR_NODE_SECRETS",
  "OCR_ALLOWED_LINE_NODE_IDS",
  "OCR_ADMIN_NODE_IDS",
]) {
  assert.match(example, new RegExp(`^${key}=`, "m"), `.env.example must list ${key}`);
  assert.match(reference, new RegExp("`" + key + "`"), `env reference must document ${key}`);
}

assert.match(reference, /production[^\n]*does not fall back[^\n]*NOTIFIER_SHARED_SECRET/i);
assert.match(reference, /previousExpiresAt[^\n]*(?:7 days|7-day)/i);
assert.doesNotMatch(
  reference,
  /Worker-to-notification-service endpoints use `NOTIFIER_SHARED_SECRET`/,
);
assert.doesNotMatch(reference, /\| `NOTIFIER_SHARED_SECRET`, `NOTIFIER_AUTH_MODE`/);
assert.doesNotMatch(
  deployment,
  /signs the request with HMAC using `NOTIFIER_SHARED_SECRET` from the process environment or the encrypted DB-backed `app_settings` row/,
);
assert.doesNotMatch(
  deployment,
  /security\/auth\/runtime binding such as[^\n]*`NOTIFIER_SHARED_SECRET`/,
);
assert.equal(
  deployment.match(/service-fault-publish-notification\.mjs[\s\\]*\n[\s\S]{0,220}?--step=baseline/g)?.length,
  2,
  "baseline dry-run and live commands must bind the deterministic baseline step",
);
assert.equal(
  deployment.match(/service-fault-publish-notification\.mjs[\s\\]*\n[\s\S]{0,220}?--step=line-down/g)?.length,
  2,
  "line-down dry-run and live commands must bind the deterministic line-down step",
);
assert.ok(
  (deployment.match(/"\$TASK9_WORKER_SERVICE" sh -lc/g)?.length ?? 0) >= 8,
  "all Task 9 publisher phases must execute from the selected worker identity",
);
assert.doesNotMatch(
  deployment,
  /exec -T notification-service sh -lc '[\s\S]{0,140}?service-fault-publish-notification\.mjs/,
);
assert.doesNotMatch(deployment, /--node-id=<allowed-worker-node-id>/);
assert.match(
  deployment,
  /service-fault-outbox-check\.mjs[^\n]*DB_PASSWORD_FILE/i,
);

console.log("node-scoped-hmac-docs: operator contract verified");
