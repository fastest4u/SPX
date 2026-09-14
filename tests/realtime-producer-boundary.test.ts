import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const producerFiles = [
  "src/controllers/poller.ts",
  "src/services/notify-rules.ts",
  "src/controllers/internal-notification-controller.ts",
] as const;

for (const relativePath of producerFiles) {
  const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
  assert.doesNotMatch(source, /\bsseBroadcaster\b/, `${relativePath} must publish through the realtime boundary`);
  assert.doesNotMatch(source, /from\s+["'][^"']*\/sse\.js["']/, `${relativePath} must not import the SSE transport`);
}

const adapter = readFileSync(resolve(process.cwd(), "src/services/realtime-publisher.ts"), "utf8");
assert.match(adapter, /from\s+["']\.\/sse\.js["']/, "the realtime adapter remains the allowed SSE singleton owner");

const teamRuntime = readFileSync(resolve(process.cwd(), "src/services/team-runtime.ts"), "utf8");
assert.match(teamRuntime, /realtimePublisher:\s*this\.realtimePublisher/, "TeamRuntime should pass the process publisher into Poller");
assert.match(teamRuntime, /realtimeSource:\s*this\.realtimeSource/, "TeamRuntime should pass the exact source into Poller");
const runtimeManager = readFileSync(resolve(process.cwd(), "src/services/team-runtime-manager.ts"), "utf8");
assert.match(runtimeManager, /createRuntimeRealtimePublisher\(options\.realtimePublisherOptions\)/, "manager should expose the typed local/remote selector seam");
const appSource = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
assert.equal(
  (appSource.match(/createRuntimeRealtimePublisher\(/g) ?? []).length,
  1,
  "the executable should construct the production boundary once",
);
assert.match(
  appSource,
  /createRuntimeRealtimePublisher\(\s*env\.REALTIME_SERVICE_URL\s*\?\s*\{/,
  "the executable should select the configured remote boundary or local compatibility path",
);
assert.match(appSource, /realtimePublisher:\s*runtimeRealtimePublisher/, "the executable should inject the shared publisher into team runtimes");
assert.match(
  appSource,
  /publishTeamRuntimeMetrics:\s*env\.SPX_ROLE\s*===\s*"notifier"\s*\|\|\s*env\.SPX_ROLE\s*===\s*"combined"/,
  "dedicated notification-service must publish only its admin aggregate",
);
