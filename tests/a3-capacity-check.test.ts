import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ReadableStream } from "node:stream/web";

import {
  collectCapacitySnapshot,
  collectInstalledPhase3CapacityEvidence,
  evaluateCapacitySnapshot,
  thresholdsFromApprovedPolicy,
  validateInstalledPhase3FinalRuntimeInventory,
} from "../scripts/a3-capacity-check.mjs";

const thresholds = {
  maxCpuPercent: 70,
  minMemoryFreeBytes: 4_000_000_000,
  minDiskFreeBytes: 10_000_000_000,
  minInodeFreePercent: 20,
  minPidFree: 1_000,
  maxNetworkRxUtilizationPercent: 70,
  maxNetworkTxUtilizationPercent: 70,
  minNetworkHeadroomMbps: 100,
  minMysqlConnectionsFree: 40,
  minMysqlConnectionHeadroomPercent: 30,
  maxProductionP95LatencyMs: 200,
  maxLatencyIncreasePercent: 25,
};

const healthy = {
  a3CpuPercent: 20,
  a3MemoryFreeBytes: 8_000_000_000,
  a3DiskFreeBytes: 20_000_000_000,
  a3InodeFreePercent: 75,
  a3PidFree: 5_000,
  a3NetworkRxUtilizationPercent: 15,
  a3NetworkTxUtilizationPercent: 18,
  a3NetworkHeadroomMbps: 250,
  a3StagingPortAvailable: true,
  sharedMysqlConnectionsFree: 80,
  sharedMysqlConnectionHeadroomPercent: 70,
  productionP95LatencyMs: 80,
  productionBaselineP95LatencyMs: 75,
  productionReady: true,
};

async function main(): Promise<void> {
assert.deepEqual(evaluateCapacitySnapshot(healthy, thresholds), { ok: true, failures: [] });
assert.deepEqual(
  evaluateCapacitySnapshot({ ...healthy, productionReady: false }, thresholds).failures,
  ["PRODUCTION_NOT_READY"],
);
assert.deepEqual(
  evaluateCapacitySnapshot({ ...healthy, a3StagingPortAvailable: false }, thresholds).failures,
  ["STAGING_PORT_COLLISION"],
);
assert.deepEqual(
  evaluateCapacitySnapshot({ ...healthy, productionP95LatencyMs: 450 }, thresholds).failures,
  ["PRODUCTION_LATENCY_BUDGET_EXCEEDED", "PRODUCTION_LATENCY_INCREASE_EXCEEDED"],
);
assert.deepEqual(
  evaluateCapacitySnapshot({ ...healthy, sharedMysqlConnectionsFree: 39 }, thresholds).failures,
  ["MYSQL_CONNECTION_HEADROOM_LOW"],
);
assert.deepEqual(
  evaluateCapacitySnapshot({ ...healthy, a3CpuPercent: Number.NaN }, thresholds).failures,
  ["CAPACITY_SNAPSHOT_INVALID"],
);

assert.deepEqual(
  thresholdsFromApprovedPolicy({
    maxCpuPercent: 70,
    minMemoryFreeBytes: 4_000_000_000,
    minMysqlConnectionsFree: 40,
    productionP95LatencyMs: 200,
    maxLatencyIncreasePercent: 25,
  }),
  thresholds,
);

assert.deepEqual(
  await collectCapacitySnapshot({
    async collectLocal() {
      return {
        a3CpuPercent: healthy.a3CpuPercent,
        a3MemoryFreeBytes: healthy.a3MemoryFreeBytes,
        a3DiskFreeBytes: healthy.a3DiskFreeBytes,
        a3InodeFreePercent: healthy.a3InodeFreePercent,
        a3PidFree: healthy.a3PidFree,
        a3NetworkRxUtilizationPercent: healthy.a3NetworkRxUtilizationPercent,
        a3NetworkTxUtilizationPercent: healthy.a3NetworkTxUtilizationPercent,
        a3NetworkHeadroomMbps: healthy.a3NetworkHeadroomMbps,
        a3StagingPortAvailable: healthy.a3StagingPortAvailable,
      };
    },
    async collectMysql() {
      return {
        sharedMysqlConnectionsFree: healthy.sharedMysqlConnectionsFree,
        sharedMysqlConnectionHeadroomPercent: healthy.sharedMysqlConnectionHeadroomPercent,
      };
    },
    async collectProduction() {
      return {
        productionP95LatencyMs: healthy.productionP95LatencyMs,
        productionReady: healthy.productionReady,
      };
    },
    productionBaselineP95LatencyMs: healthy.productionBaselineP95LatencyMs,
  }),
  healthy,
);

const originalNodeEnvironment = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
const endpoint = "https://observer.example/internal/ready";
const finalPolicyBytes = Buffer.from(
  JSON.stringify({ endpoint, schemaVersion: 1 }),
  "utf8",
);
const expectedPolicySha256 = createHash("sha256").update(finalPolicyBytes).digest("hex");
const continuousPolicyBytes = Buffer.from(
  JSON.stringify({
    credentialPath: "/run/credentials/spx-production-observer-token",
    endpoint,
  }),
  "utf8",
);
const monotonic = Number(process.hrtime.bigint() / 1_000_000n);
const lease = (role: "guard" | "watchdog", suffix: string) => ({
  schemaVersion: 1,
  role,
  state: "armed",
  breachCount: 0,
  baselineP95LatencyMs: role === "guard" ? 75 : null,
  leaseId: `00000000-0000-4000-8000-00000000000${suffix}`,
  stagingRunId: "staging-run-1",
  pid: role === "guard" ? 101 : 102,
  startedMonotonicMs: monotonic - 20_000,
  heartbeatMonotonicMs: monotonic - 100,
  heartbeatAgeMs: 100,
});
const leases = () => ({
  stagingRunId: "staging-run-1",
  guard: lease("guard", "1"),
  watchdog: lease("watchdog", "2"),
  maxAgeMs: 10_000,
});
const context = {
  installedBinding: {
    candidateSha: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    stagingTargetDescriptorSha256: "c".repeat(64),
    operatorBundleSha256: "d".repeat(64),
    stagingRunId: "staging-run-1",
  },
  descriptor: {
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    composeProject: "spx-staging",
    target: { productionObserverPolicySha256: expectedPolicySha256 },
    database: {
      name: "spx_staging",
      accountHosts: { "phase3-observer": "172.17.0.1" },
    },
  },
  envelope: {
    policy: {
      thresholds: {
        maxCpuPercent: 70,
        minMemoryFreeBytes: 4_000_000_000,
        minMysqlConnectionsFree: 40,
        productionP95LatencyMs: 200,
        maxLatencyIncreasePercent: 25,
      },
    },
  },
};
const capability = {
  database: {},
  phase3: { canaryTeamId: 2, canaryEpoch: "phase3-ifn-test" },
};

function runtimeEntry(
  service: string,
  nodeId: string,
  status: "running" | "exited",
  environment: string[],
  suffix: string,
) {
  return {
    service,
    containerId: suffix.repeat(64),
    imageId: context.installedBinding.imageDigest,
    status,
    paused: false,
    restarting: false,
    health: status === "running" ? "healthy" : null,
    labels: {
      "com.docker.compose.project": "spx-staging",
      "com.docker.compose.service": service,
      "com.spx.environment": "staging",
      "com.spx.release-sha": context.installedBinding.candidateSha,
      "com.spx.target-descriptor-sha256":
        context.installedBinding.stagingTargetDescriptorSha256,
      "com.spx.operator-bundle-sha256": context.installedBinding.operatorBundleSha256,
      "com.spx.staging-run-id": context.installedBinding.stagingRunId,
    },
    environment: [`SPX_NODE_ID=${nodeId}`, ...environment],
  };
}

function runtimeInventory() {
  return [
    runtimeEntry(
      "auto-accept-ifn-phase3",
      "stg-auto-accept-ifn-phase3-1",
      "exited",
      [
        "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=false",
        "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=true",
        "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=true",
      ],
      "1",
    ),
    runtimeEntry(
      "poller-ifn-phase3",
      "stg-poller-ifn-phase3-1",
      "exited",
      [
        "AUTO_ACCEPT_JOB_CUTOVER_EPOCH=phase3-ifn-test",
        "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=false",
        "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=false",
        "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=false",
      ],
      "2",
    ),
    runtimeEntry(
      "worker-ifn-split",
      "stg-worker-ifn-split-1",
      "running",
      ["SPX_ROLE=worker", "RUN_TEAM_IDS=2"],
      "3",
    ),
  ];
}

function privateSnapshot(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    bytes,
    dev: 1n,
    ino: 2n,
    uid: process.platform === "win32" ? null : 0,
    mode: 0o400,
    nlink: 1,
    regular: true,
    symbolicLink: false,
    ...overrides,
  };
}

function responseFor(value: unknown, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

function collectorPorts(overrides: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let policyReads = 0;
  const connection = {
    async query(input: unknown) {
      assert.equal(typeof input, "object");
      const request = input as { sql: string; values: unknown[]; timeout: number };
      assert.equal(request.timeout, 5_000);
      assert.deepEqual(request.values, []);
      calls.push({ kind: "query", request, connection });
      if (/CURRENT_USER/.test(request.sql)) {
        return [[{
          account: "spx_stg_phase3_observer@172.17.0.1",
          databaseName: "spx_staging",
        }]];
      }
      if (/max_connections/.test(request.sql)) return [[{ maxConnections: 200 }]];
      if (/Threads_connected/.test(request.sql)) return [[{ connected: 20 }]];
      return [[]];
    },
    async end() {
      calls.push({ kind: "end", connection });
    },
  };
  const ports = {
    async loadContext() { calls.push({ kind: "context" }); return context; },
    async loadCapability() { calls.push({ kind: "capability" }); return capability; },
    async loadCredential() {
      calls.push({ kind: "credential" });
      return { host: "fixed-db", user: "spx_stg_phase3_observer", database: "spx_staging" };
    },
    async loadLeases() { calls.push({ kind: "leases" }); return leases(); },
    async readFinalPolicy() {
      policyReads += 1;
      calls.push({ kind: `policy-${policyReads}` });
      return privateSnapshot(finalPolicyBytes);
    },
    async readFinalToken() {
      calls.push({ kind: "token" });
      return privateSnapshot(Buffer.from("A".repeat(32), "utf8"));
    },
    async readContinuousPolicy() {
      calls.push({ kind: "continuous-policy" });
      return continuousPolicyBytes;
    },
    async collectRuntimeInventory() {
      calls.push({ kind: "runtime" });
      return runtimeInventory();
    },
    async collectLocal() {
      calls.push({ kind: "local" });
      const { a3StagingPortAvailable: _omitted, ...local } = healthy;
      return Object.fromEntries(
        Object.entries(local).filter(([key]) => key.startsWith("a3")),
      );
    },
    async createMysqlConnection(config: unknown) {
      calls.push({ kind: "connect", config, connection });
      assert.equal((config as { connectTimeout: number }).connectTimeout, 5_000);
      return connection;
    },
    loadGrantContract() { calls.push({ kind: "contract" }); return { roles: {} }; },
    async runGrantCheck(facade: { query: (sql: string, values: unknown[]) => Promise<unknown> }) {
      calls.push({ kind: "grants", connection });
      await facade.query("GRANT EVIDENCE", []);
      return { ok: true, failureCodes: [] };
    },
    async fetch(url: URL, init: Record<string, unknown>) {
      calls.push({ kind: "fetch", url, init });
      return responseFor({ p95LatencyMs: 80, ready: true });
    },
    ...overrides,
  };
  return { ports, calls, connection };
}

assert.equal(
  validateInstalledPhase3FinalRuntimeInventory(runtimeInventory(), context, capability),
  true,
);
const invalidRuntimeInventories: Array<[string, unknown]> = [];
invalidRuntimeInventories.push(
  ["missing service", runtimeInventory().slice(0, 2)],
  ["duplicate service", [runtimeInventory()[0], runtimeInventory()[0], runtimeInventory()[2]]],
  ["extra service", [...runtimeInventory(), runtimeInventory()[2]]],
  ["malformed inventory", { entries: runtimeInventory() }],
);
const sparseRuntimeInventory = runtimeInventory();
delete (sparseRuntimeInventory as Array<unknown>)[1];
invalidRuntimeInventories.push(["sparse inventory", sparseRuntimeInventory]);
const missingEnvironmentField = runtimeInventory();
delete (missingEnvironmentField[0] as unknown as { environment?: string[] }).environment;
invalidRuntimeInventories.push(["missing environment field", missingEnvironmentField]);
for (const [labelKey, wrong] of [
  ["com.docker.compose.project", "other"],
  ["com.docker.compose.service", "other"],
  ["com.spx.environment", "production"],
  ["com.spx.release-sha", "wrong"],
  ["com.spx.target-descriptor-sha256", "wrong"],
  ["com.spx.operator-bundle-sha256", "wrong"],
  ["com.spx.staging-run-id", "wrong"],
] as const) {
  const inventory = runtimeInventory();
  inventory[0].labels[labelKey] = wrong;
  invalidRuntimeInventories.push([`wrong ${labelKey}`, inventory]);
}
for (const [name, mutate] of [
  ["wrong image", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].imageId = `sha256:${"9".repeat(64)}`; }],
  ["wrong node", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment[0] = "SPX_NODE_ID=caller-node"; }],
  ["missing node", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment.shift(); }],
  ["missing consumer flag", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment.splice(1, 1); }],
  ["duplicate environment", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment.push("SPX_NODE_ID=duplicate"); }],
  ["malformed environment", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment.push("MALFORMED"); }],
  ["duplicate container", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].containerId = inventory[0].containerId; }],
  ["poller not exited", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].status = "running"; }],
  ["poller paused", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].paused = true; }],
  ["poller restarting", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].restarting = true; }],
  ["poller cutover", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].environment[1] = "AUTO_ACCEPT_JOB_CUTOVER_EPOCH=wrong"; }],
  ["poller dry run", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].environment[2] = "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=true"; }],
  ["poller real", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].environment[3] = "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=true"; }],
  ["poller settlement", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[1].environment[4] = "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=true"; }],
  ["consumer not exited", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].status = "running"; }],
  ["consumer paused", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].paused = true; }],
  ["consumer restarting", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].restarting = true; }],
  ["consumer dry run", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment[1] = "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=true"; }],
  ["consumer real", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment[2] = "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=false"; }],
  ["consumer settlement", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[0].environment[3] = "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=false"; }],
  ["legacy not running", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[2].status = "exited"; }],
  ["legacy paused", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[2].paused = true; }],
  ["legacy restarting", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[2].restarting = true; }],
  ["legacy health", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[2].health = "unhealthy"; }],
  ["legacy role", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[2].environment[1] = "SPX_ROLE=combined"; }],
  ["legacy team", (inventory: ReturnType<typeof runtimeInventory>) => { inventory[2].environment[2] = "RUN_TEAM_IDS=1"; }],
] as const) {
  const inventory = runtimeInventory();
  mutate(inventory);
  invalidRuntimeInventories.push([name, inventory]);
}
for (const [name, inventory] of invalidRuntimeInventories) {
  assert.throws(
    () => validateInstalledPhase3FinalRuntimeInventory(inventory, context, capability),
    /Phase 3 final runtime inventory is invalid/i,
    name,
  );
}

const booleanRuntimeBypass = collectorPorts({
  async collectRuntimeInventory() { return true; },
});
await assert.rejects(
  collectInstalledPhase3CapacityEvidence(booleanRuntimeBypass.ports),
  /capacity evidence collection failed/i,
  "a test port cannot bypass code-owned runtime validation with a boolean",
);

const successful = collectorPorts();
const installed = await collectInstalledPhase3CapacityEvidence(successful.ports);
assert.deepEqual(Object.keys(installed), ["capacity", "productionObserver"]);
assert.deepEqual(Object.keys(installed.capacity), [
  "schemaVersion", "observedAt", "ok", "failures", "measurements", "thresholds",
]);
assert.deepEqual(Object.keys(installed.capacity.measurements), [
  "a3CpuPercent", "a3MemoryFreeBytes", "a3DiskFreeBytes", "a3InodeFreePercent",
  "a3PidFree", "a3NetworkRxUtilizationPercent", "a3NetworkTxUtilizationPercent",
  "a3NetworkHeadroomMbps", "sharedMysqlConnectionsFree",
  "sharedMysqlConnectionHeadroomPercent", "productionP95LatencyMs",
  "productionBaselineP95LatencyMs", "productionLatencyIncreasePercent",
]);
assert.deepEqual(installed.capacity.thresholds, {
  envelopeApproved: {
    maxCpuPercent: 70,
    minMemoryFreeBytes: 4_000_000_000,
    minMysqlConnectionsFree: 40,
    maxProductionP95LatencyMs: 200,
    maxLatencyIncreasePercent: 25,
  },
  codeOwnedFixed: {
    minDiskFreeBytes: 10_000_000_000,
    minInodeFreePercent: 20,
    minPidFree: 1_000,
    maxNetworkRxUtilizationPercent: 70,
    maxNetworkTxUtilizationPercent: 70,
    minNetworkHeadroomMbps: 100,
    minMysqlConnectionHeadroomPercent: 30,
  },
});
assert.equal(installed.capacity.measurements.productionLatencyIncreasePercent, 100 / 15);
assert.equal(installed.capacity.ok, true);
assert.deepEqual(installed.capacity.failures, []);
assert.equal(installed.productionObserver.expectedPolicySha256, expectedPolicySha256);
assert.equal(installed.productionObserver.requestMethod, "GET");
assert.deepEqual(installed.productionObserver.response, { p95LatencyMs: 80, ready: true });
assert.equal(installed.productionObserver.observedAt, installed.capacity.observedAt);
assert.deepEqual(installed.productionObserver.thresholdResult, {
  absoluteP95WithinApprovedLimit: true,
  latencyIncreaseWithinApprovedLimit: true,
  passed: true,
});
assert.equal(Object.isFrozen(installed), true);
assert.equal(Object.isFrozen(installed.capacity.measurements), true);
assert.equal(Object.isFrozen(installed.capacity.thresholds.envelopeApproved), true);
assert.equal(Object.isFrozen(installed.productionObserver.thresholdResult), true);
const serialized = JSON.stringify(installed);
assert.doesNotMatch(serialized, /a3StagingPortAvailable|observer\.example|Bearer|fixed-db|172\.17|GRANT/i);
const fetchCall = successful.calls.find((entry) => entry.kind === "fetch")!;
assert.equal((fetchCall.url as URL).href, endpoint);
assert.ok((fetchCall.init as { signal: AbortSignal }).signal instanceof AbortSignal);
assert.deepEqual({ ...(fetchCall.init as Record<string, unknown>), signal: "bounded" }, {
  method: "GET",
  redirect: "error",
  signal: "bounded",
  headers: { accept: "application/json", authorization: `Bearer ${"A".repeat(32)}` },
});
assert.ok(
  successful.calls.findIndex((entry) => entry.kind === "policy-1") <
    successful.calls.findIndex((entry) => entry.kind === "token"),
);
assert.ok(
  successful.calls.findIndex((entry) => entry.kind === "leases") <
    successful.calls.findIndex((entry) => entry.kind === "runtime"),
  "the initial leases must bracket every runtime collection",
);
assert.ok(
  successful.calls.findIndex((entry) => entry.kind === "runtime") <
    successful.calls.findIndex((entry) => entry.kind === "policy-1"),
);
assert.equal(successful.calls.filter((entry) => entry.kind === "leases").length, 2);
assert.equal(successful.calls.filter((entry) => entry.kind === "policy-2").length, 1);
assert.equal(successful.calls.filter((entry) => entry.kind === "end").length, 1);
assert.equal(successful.calls.filter((entry) => entry.kind === "connect")[0].connection, successful.connection);

for (const [name, mutate] of [
  ["zero baseline", (value: ReturnType<typeof leases>) => { value.guard.baselineP95LatencyMs = 0; }],
  ["null baseline", (value: ReturnType<typeof leases>) => { value.guard.baselineP95LatencyMs = null; }],
  ["NaN baseline", (value: ReturnType<typeof leases>) => { value.guard.baselineP95LatencyMs = Number.NaN; }],
  ["aborted guard", (value: ReturnType<typeof leases>) => { value.guard.state = "aborted"; }],
  ["stale guard", (value: ReturnType<typeof leases>) => { value.guard.heartbeatAgeMs = 10_001; }],
  ["future guard", (value: ReturnType<typeof leases>) => { value.guard.heartbeatMonotonicMs = monotonic + 10_000; }],
  ["wrong run", (value: ReturnType<typeof leases>) => { value.watchdog.stagingRunId = "other"; }],
  ["equal ids", (value: ReturnType<typeof leases>) => { value.watchdog.leaseId = value.guard.leaseId; }],
] as const) {
  const altered = leases();
  mutate(altered);
  const harness = collectorPorts({ async loadLeases() { return altered; } });
  await assert.rejects(
    collectInstalledPhase3CapacityEvidence(harness.ports),
    /capacity evidence prerequisite is invalid/i,
    name,
  );
}

for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"] as const) {
  let read = 0;
  const changed = collectorPorts({
    async loadLeases() {
      read += 1;
      const value = leases();
      if (read === 2) {
        if (field === "leaseId") value.guard[field] = "00000000-0000-4000-8000-000000000009";
        else if (field === "baselineP95LatencyMs") value.guard[field] = 76;
        else value.guard[field] += 1;
      }
      return value;
    },
  });
  await assert.rejects(
    collectInstalledPhase3CapacityEvidence(changed.ports),
    /capacity evidence prerequisite changed/i,
    `changed ${field}`,
  );
}
for (const role of ["guard", "watchdog"] as const) {
  let read = 0;
  const regressed = collectorPorts({
    async loadLeases() {
      read += 1;
      const value = leases();
      if (read === 2) {
        value[role].heartbeatMonotonicMs -= 1;
        value[role].heartbeatAgeMs += 1;
      }
      return value;
    },
  });
  await assert.rejects(
    collectInstalledPhase3CapacityEvidence(regressed.ports),
    /capacity evidence prerequisite changed/i,
    `${role} heartbeat regression`,
  );
}

for (const metadata of [
  { symbolicLink: true }, { regular: false }, { nlink: 2 }, { mode: 0o600 },
  ...(process.platform === "win32" ? [] : [{ uid: 1000 }]),
]) {
  let tokenOpened = false;
  const invalidPolicy = collectorPorts({
    async readFinalPolicy() { return privateSnapshot(finalPolicyBytes, metadata); },
    async readFinalToken() { tokenOpened = true; throw new Error("must not open"); },
  });
  await assert.rejects(
    collectInstalledPhase3CapacityEvidence(invalidPolicy.ports),
    /capacity evidence collection failed/i,
  );
  assert.equal(tokenOpened, false);
}

for (const invalidToken of [Buffer.alloc(31, 0x41), Buffer.from(`${"A".repeat(32)}\n`)]) {
  const harness = collectorPorts({
    async readFinalToken() { return privateSnapshot(invalidToken); },
  });
  await assert.rejects(collectInstalledPhase3CapacityEvidence(harness.ports), /collection failed/i);
}
for (const metadata of [{ symbolicLink: true }, { nlink: 2 }, { mode: 0o600 }]) {
  const harness = collectorPorts({
    async readFinalToken() {
      return privateSnapshot(Buffer.from("A".repeat(32)), metadata);
    },
  });
  await assert.rejects(collectInstalledPhase3CapacityEvidence(harness.ports), /collection failed/i);
}

let postPolicyRead = 0;
const replacedPolicy = collectorPorts({
  async readFinalPolicy() {
    postPolicyRead += 1;
    return privateSnapshot(finalPolicyBytes, postPolicyRead === 2 ? { ino: 999n } : {});
  },
});
await assert.rejects(
  collectInstalledPhase3CapacityEvidence(replacedPolicy.ports),
  /capacity evidence prerequisite changed/i,
);

const mismatchedEndpoint = collectorPorts({
  async readContinuousPolicy() {
    return Buffer.from(JSON.stringify({
      credentialPath: "/run/credentials/spx-production-observer-token",
      endpoint: "https://other.example/ready",
    }));
  },
});
await assert.rejects(
  collectInstalledPhase3CapacityEvidence(mismatchedEndpoint.ports),
  /capacity evidence collection failed/i,
);

for (const response of [
  responseFor({ p95LatencyMs: 80, ready: true, extra: true }),
  responseFor({ p95LatencyMs: -1, ready: true }),
  responseFor({ p95LatencyMs: 80, ready: "yes" }),
  responseFor({ p95LatencyMs: 80, ready: true }, 302),
  {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from("{invalid")); controller.close(); },
    }),
  },
  {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.alloc(8_193, 0x41)); controller.close(); },
    }),
  },
]) {
  const harness = collectorPorts({ async fetch() { return response; } });
  await assert.rejects(collectInstalledPhase3CapacityEvidence(harness.ports), /collection failed/i);
}

for (const identity of [
  { account: "wrong@172.17.0.1", databaseName: "spx_staging" },
  { account: "spx_stg_phase3_observer@%", databaseName: "spx_staging" },
  { account: "spx_stg_phase3_observer@172.17.0.1", databaseName: "production" },
]) {
  let capacityRead = false;
  const connection = {
    async query(input: { sql: string }) {
      if (/CURRENT_USER/.test(input.sql)) return [[identity]];
      capacityRead = true;
      return [[]];
    },
    async end() {},
  };
  const harness = collectorPorts({ async createMysqlConnection() { return connection; } });
  await assert.rejects(collectInstalledPhase3CapacityEvidence(harness.ports), /collection failed/i);
  assert.equal(capacityRead, false);
}

let grantCapacityRead = false;
const badGrants = collectorPorts({
  async runGrantCheck() { return { ok: false, failureCodes: ["excess_privilege_present"] }; },
  async createMysqlConnection() {
    return {
      async query(input: { sql: string }) {
        if (/CURRENT_USER/.test(input.sql)) {
          return [[{ account: "spx_stg_phase3_observer@172.17.0.1", databaseName: "spx_staging" }]];
        }
        grantCapacityRead = true;
        return [[]];
      },
      async end() {},
    };
  },
});
await assert.rejects(collectInstalledPhase3CapacityEvidence(badGrants.ports), /collection failed/i);
assert.equal(grantCapacityRead, false);

const oldDbHost = process.env.DB_HOST;
process.env.DB_HOST = "poisoned-production-host";
const poisoned = collectorPorts();
await collectInstalledPhase3CapacityEvidence(poisoned.ports);
assert.doesNotMatch(JSON.stringify(poisoned.calls), /poisoned-production-host/);
if (oldDbHost === undefined) delete process.env.DB_HOST;
else process.env.DB_HOST = oldDbHost;

await assert.rejects(
  collectInstalledPhase3CapacityEvidence({ ...collectorPorts().ports, finalPolicyPath: "/tmp/x" }),
  /test-only capacity evidence ports are invalid/i,
);
await assert.rejects(
  collectInstalledPhase3CapacityEvidence({ async loadContext() { return context; } }),
  /test-only capacity evidence ports are invalid/i,
);
const strictPortCases: Array<[string, object]> = [];
const symbolPorts = { ...collectorPorts().ports };
Object.defineProperty(symbolPorts, Symbol("hidden"), { value: () => true, enumerable: true });
strictPortCases.push(["symbol", symbolPorts]);
const hiddenPorts = { ...collectorPorts().ports };
Object.defineProperty(hiddenPorts, "loadContext", {
  value: hiddenPorts.loadContext,
  enumerable: false,
  configurable: true,
  writable: true,
});
strictPortCases.push(["hidden", hiddenPorts]);
const accessorPorts = { ...collectorPorts().ports };
const accessorLoadContext = accessorPorts.loadContext;
Object.defineProperty(accessorPorts, "loadContext", {
  get() { return accessorLoadContext; },
  enumerable: true,
  configurable: true,
});
strictPortCases.push(["accessor", accessorPorts]);
const prototypePorts = Object.assign(Object.create({ inherited: true }), collectorPorts().ports);
strictPortCases.push(["prototype", prototypePorts]);
for (const [name, ports] of strictPortCases) {
  await assert.rejects(
    collectInstalledPhase3CapacityEvidence(ports),
    /test-only capacity evidence ports are invalid/i,
    name,
  );
}
process.env.NODE_ENV = "production";
await assert.rejects(
  collectInstalledPhase3CapacityEvidence(collectorPorts().ports),
  /accepts zero arguments/i,
);
if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = originalNodeEnvironment;

console.log("A3 capacity evaluator tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
