import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");

assert.match(source, /startRuntimeNodeHeartbeat/);
assert.match(source, /loadRuntimeReleaseIdentity/);
assert.match(
  source,
  /const runtimeReleaseIdentity = env\.NODE_ENV === "production"\s*\? loadRuntimeReleaseIdentity\(\)\s*:\s*undefined/,
  "production containers must fail closed while loading immutable runtime identity",
);
assert.match(source, /const runtimeStartedAt = new Date\(\)\.toISOString\(\)/);
assert.ok(
  (source.match(/releaseIdentity:\s*runtimeReleaseIdentity/g) ?? []).length >= 2,
  "worker leases and dedicated heartbeats must register the same release identity",
);
assert.ok(
  (source.match(/startedAt:\s*runtimeStartedAt/g) ?? []).length >= 2,
  "worker leases and dedicated heartbeats must share one process start time",
);
assert.equal(
  (source.match(/await startRuntimeNodeHeartbeat\s*\(/g) ?? []).length,
  1,
  "app must await exactly one runtime-node heartbeat registration",
);
assert.match(
  source,
  /env\.SPX_ROLE === "poller-service"\s*\|\|\s*env\.SPX_ROLE === "auto-accept-service"\s*\|\|\s*env\.SPX_ROLE === "line-service"/,
);
assert.match(
  source,
  /assignedTeamIds:\s*heartbeatRuntimeRole === "line-service" \? \[\] : env\.RUN_TEAM_IDS/,
);
assert.match(source, /enabledLoopModes:\s*enabledRuntimeNodeLoopModes/);
assert.match(source, /startupPlan\.runAutoAcceptDryRunLoop/);
assert.match(source, /startupPlan\.runAutoAcceptRealLoop/);
assert.match(source, /startupPlan\.runAutoAcceptSettlementLoop/);
assert.match(source, /enabledRuntimeNodeLoopModes\s*=\s*\["poller"\]/);
assert.match(source, /runtimeNodeHeartbeat\?\.stop\(\)/);

const registrationStart = source.indexOf("await startRuntimeNodeHeartbeat(");
const firstBackgroundLoopStart = Math.min(
  ...[
    source.indexOf("startNotificationDispatchLoop({"),
    source.indexOf("startAutoAcceptJobDryRunWorkerLoop({"),
    source.indexOf("startAutoAcceptJobRealWorkerLoop({"),
    source.indexOf("startAutoAcceptJobSettlementWorkerLoop({"),
    source.indexOf("startDesiredStateLoop()"),
  ].filter((index) => index >= 0),
);
assert.ok(registrationStart > source.indexOf("validateRuntimeConfig();"));
assert.ok(registrationStart > source.indexOf("await ensureDefaultTeamFromLegacySettings();"));
assert.ok(registrationStart < firstBackgroundLoopStart, "heartbeat registration must precede background loops");

const registrationEnd = source.indexOf("});", registrationStart);
const registration = source.slice(registrationStart, registrationEnd);
for (const forbidden of ["COOKIE", "SECRET", "URL", "HOST", "LINE_"]) {
  assert.equal(registration.includes(forbidden), false, `heartbeat metadata must not include ${forbidden}`);
}
