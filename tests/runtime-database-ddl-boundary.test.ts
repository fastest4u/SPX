import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync("src/db/client.ts", "utf8");
const readiness = readFileSync("src/db/runtime-schema-readiness.ts", "utf8");
const metrics = readFileSync("src/repositories/metrics-repository.ts", "utf8");
const jwt = readFileSync("src/repositories/jwt-blacklist-repository.ts", "utf8");
const app = readFileSync("src/app.ts", "utf8");

assert.match(
  client,
  /runtimeSchemaMutationsAllowed\(\)[\s\S]*?createSpxBookingHistoryTable\(\)[\s\S]*?ensureReleasedRuntimeSchema\(\)/,
);
assert.match(
  client,
  /runtimeSchemaMutationsAllowed\(\)[\s\S]*?createDashboardTables\(\)[\s\S]*?ensureReleasedRuntimeSchema\(\)/,
);
assert.match(readiness, /SELECT name AS name,[\s\S]*FROM schema_migrations[\s\S]*ORDER BY name/);
assert.doesNotMatch(readiness, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/);
assert.doesNotMatch(metrics, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/);
assert.match(jwt, /if \(runtimeSchemaMutationsAllowed\(\)\) \{[\s\S]*CREATE TABLE IF NOT EXISTS jwt_blacklist/);
assert.match(
  app,
  /env\.SPX_ROLE === "api" \|\| env\.SPX_ROLE === "notifier"/,
  "legacy JSON/default-team bootstrap must not run in line, notification, realtime, or worker roles",
);

console.log("runtime-database-ddl-boundary: production roles use read-only schema readiness");
