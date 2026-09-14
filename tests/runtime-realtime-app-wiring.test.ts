import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
const httpServerSource = readFileSync(resolve(process.cwd(), "src/services/http-server.ts"), "utf8");

assert.match(source, /createRealtimeServiceClient/);
assert.match(source, /env\.REALTIME_SERVICE_URL\s*\?/);
assert.match(source, /url:\s*`\$\{env\.REALTIME_SERVICE_URL\}\/events`/);
assert.match(source, /sharedSecret:\s*env\.REALTIME_SHARED_SECRET/);
assert.match(source, /nodeId:\s*env\.SPX_NODE_ID/);
assert.match(source, /requestTimeoutMs:\s*env\.REALTIME_REQUEST_TIMEOUT_MS/);
assert.match(source, /baseUrl:\s*env\.REALTIME_SERVICE_URL/);
assert.match(source, /connectTimeoutMs:\s*env\.REALTIME_REQUEST_TIMEOUT_MS/);
assert.match(source, /realtimeReadGateway/);
assert.match(source, /acquireRealtimeServiceSingletonLease/);
assert.match(source, /env\.SPX_ROLE === "realtime-service"/);
assert.match(source, /await realtimeSingletonLease\?\.release\(\)/);
assert.match(
  source,
  /const runLegacyDataBootstrap =\s*roleUsesDatabase\(env\.SPX_ROLE\) &&\s*\(env\.SPX_ROLE === "api" \|\| env\.SPX_ROLE === "notifier"\)/,
);
assert.match(source, /runLegacyDataBootstrap\s*&&\s*\(/);
assert.match(
  source,
  /if \(runLegacyDataBootstrap && canUseSettingsDatabase\(\)\) \{\s*await ensureDefaultTeamFromLegacySettings\(\)/,
);

const httpStart = source.indexOf("await startHttpServer(");
assert.ok(httpStart >= 0);
const httpWiring = source.slice(httpStart, source.indexOf("httpStarted = true", httpStart));
assert.match(httpWiring, /realtimeReadGateway/);
assert.match(
  httpServerSource,
  /dashboardController,\s*\{\s*realtimeReadGateway:\s*options\.realtimeReadGateway,\s*realtimePublisher:\s*options\.runtimeMetricsRealtimePublisher,\s*\}/,
);

assert.equal(
  /buildServiceReadiness\([\s\S]*REALTIME_SERVICE_URL/.test(source),
  false,
  "web startup must not add realtime-service to readiness",
);
