const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIMARY_SERVICES = Object.freeze([
  "line-service",
  "notification-service",
  "ocr-service",
  "web-api",
  "worker-ptwl-split",
]);
const TEAM2_SERVICES = Object.freeze(["worker-ifn-split"]);

function fail(message) {
  throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!object(value)) fail(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} is invalid`);
  }
}

function pattern(value, expected, label) {
  if (typeof value !== "string" || !expected.test(value)) fail(`${label} is invalid`);
}

function iso(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(`${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} is invalid`);
  }
  return milliseconds;
}

function exactServices(actual, expected, label) {
  if (
    !Array.isArray(actual)
    || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
    || actual.some((value) => typeof value !== "string" || !SERVICE.test(value))
  ) fail(`${label} service set is invalid`);
}

function teamOwners(value, unit, projection) {
  if (!object(value)) fail("candidate team owner is invalid");
  const expectedTeam = unit === "primary" ? "1" : "2";
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, expectedTeam)) {
    fail("candidate team owner set is invalid");
  }
  pattern(value[expectedTeam], OWNER, "candidate team owner");
  const expectedOwner = unit === "team2"
    ? "prod-worker-ifn-node2"
    : projection === "legacy"
      ? "prod-worker-ptwl-1"
      : "prod-worker-ptwl-split-1";
  if (value[expectedTeam] !== expectedOwner) fail("candidate team owner is invalid");
}

function publishedPorts(value, unit) {
  if (!Array.isArray(value)) fail("candidate published ports are invalid");
  if (unit === "team2") {
    if (value.length !== 0) fail("TEAM 2 must not publish a port");
    return;
  }
  if (value.length !== 1 || value[0] !== "127.0.0.1:3000:3000/tcp") {
    fail("primary published port is invalid");
  }
}

export function validateFirstCutoverApproval(approval, nowMs = Date.now()) {
  exactKeys(approval, [
    "schemaVersion",
    "operationId",
    "deploymentUnit",
    "releaseSha",
    "imageRef",
    "imageDigest",
    "descriptorArtifactSha256",
    "identityApprovalSha256",
    "backupEvidenceSha256",
    "legacy",
    "candidate",
    "maintenanceWindow",
    "healthTimeoutMs",
    "rollbackOwner",
  ], "first cutover approval");
  if (approval.schemaVersion !== 1) fail("first cutover approval schema is invalid");
  pattern(approval.operationId, ID, "first cutover operation ID");
  if (!["primary", "team2"].includes(approval.deploymentUnit)) {
    fail("first cutover deployment unit is invalid");
  }
  pattern(approval.releaseSha, COMMIT, "first cutover release SHA");
  pattern(approval.imageDigest, IMAGE_DIGEST, "first cutover image digest");
  if (approval.imageRef !== `spx-app:${approval.releaseSha}`) fail("first cutover image reference is invalid");
  for (const key of ["descriptorArtifactSha256", "identityApprovalSha256", "backupEvidenceSha256"]) {
    pattern(approval[key], HASH, `first cutover ${key}`);
  }

  exactKeys(approval.legacy, ["project", "services", "teamOwners", "snapshotSha256"], "legacy cutover unit");
  if (approval.legacy.project !== "spx") fail("legacy project is invalid");
  pattern(approval.legacy.snapshotSha256, HASH, "legacy snapshot SHA-256");
  teamOwners(approval.legacy.teamOwners, approval.deploymentUnit, "legacy");

  exactKeys(approval.candidate, [
    "project",
    "services",
    "teamOwners",
    "publishedPorts",
    "configSha256",
  ], "candidate cutover unit");
  if (approval.candidate.project !== "spx-production") fail("candidate project is invalid");
  pattern(approval.candidate.configSha256, HASH, "candidate configuration SHA-256");
  teamOwners(approval.candidate.teamOwners, approval.deploymentUnit, "candidate");
  publishedPorts(approval.candidate.publishedPorts, approval.deploymentUnit);

  if (approval.deploymentUnit === "primary") {
    exactServices(approval.legacy.services, ["notifier", "worker-ptwl"], "legacy primary");
    exactServices(approval.candidate.services, PRIMARY_SERVICES, "candidate primary");
  } else {
    exactServices(approval.legacy.services, ["worker-ifn"], "legacy TEAM 2");
    exactServices(approval.candidate.services, TEAM2_SERVICES, "candidate TEAM 2");
  }

  exactKeys(approval.maintenanceWindow, ["notBefore", "notAfter"], "maintenance window");
  const notBefore = iso(approval.maintenanceWindow.notBefore, "maintenance window start");
  const notAfter = iso(approval.maintenanceWindow.notAfter, "maintenance window end");
  if (notAfter <= notBefore || notAfter - notBefore > 24 * 60 * 60 * 1_000) {
    fail("maintenance window is invalid");
  }
  if (!Number.isFinite(nowMs) || nowMs < notBefore || nowMs > notAfter) {
    fail("first cutover approval is outside maintenance window");
  }
  if (!Number.isSafeInteger(approval.healthTimeoutMs) || approval.healthTimeoutMs < 1_000 || approval.healthTimeoutMs > 30 * 60 * 1_000) {
    fail("first cutover health timeout is invalid");
  }
  pattern(approval.rollbackOwner, ID, "first cutover rollback owner");
  return approval;
}

function assertAdapter(adapter) {
  const methods = [
    "inspectLegacy",
    "inspectCandidate",
    "writeJournal",
    "stopLegacy",
    "assertLegacyStopped",
    "startCandidate",
    "waitCandidateHealthy",
    "verifyCandidate",
    "commitProjection",
    "stopCandidate",
    "startLegacy",
    "verifyLegacy",
  ];
  if (!object(adapter) || methods.some((method) => typeof adapter[method] !== "function")) {
    fail("first cutover adapter is incomplete");
  }
}

async function journal(adapter, state, approval) {
  await adapter.writeJournal({
    schemaVersion: 1,
    operationId: approval.operationId,
    deploymentUnit: approval.deploymentUnit,
    releaseSha: approval.releaseSha,
    state,
  });
}

async function rollback(adapter, approval) {
  await journal(adapter, "rolling-back", approval);
  await adapter.stopCandidate({ approval });
  await adapter.startLegacy({ approval });
  if (await adapter.verifyLegacy({ approval }) !== true) fail("first cutover rollback verification failed");
  await journal(adapter, "rolled-back", approval);
  const restored = await adapter.inspectLegacy({ approval });
  if (restored?.running !== true || restored.snapshotSha256 !== approval.legacy.snapshotSha256) {
    fail("first cutover rollback did not restore the approved legacy snapshot");
  }
}

export async function executeFirstProductionCutover(options) {
  const now = options?.now ?? Date.now;
  if (typeof now !== "function") fail("first cutover clock is invalid");
  const approval = validateFirstCutoverApproval(options?.approval, now());
  const adapter = options?.adapter;
  assertAdapter(adapter);

  const legacy = await adapter.inspectLegacy({ approval });
  if (legacy?.running !== true || legacy.snapshotSha256 !== approval.legacy.snapshotSha256) {
    fail("legacy production snapshot does not match first cutover approval");
  }
  const candidate = await adapter.inspectCandidate({ approval });
  if (candidate?.running === true) fail("first cutover candidate is already running");

  await journal(adapter, "prepared", approval);
  let mutationStarted = false;
  try {
    mutationStarted = true;
    await adapter.stopLegacy({ approval });
    if (await adapter.assertLegacyStopped({ approval }) !== true) {
      fail("legacy production did not stop cleanly");
    }
    await journal(adapter, "legacy-stopped", approval);
    await adapter.startCandidate({ approval });
    await journal(adapter, "candidate-started", approval);
    if (await adapter.waitCandidateHealthy({ approval, timeoutMs: approval.healthTimeoutMs }) !== true) {
      fail("first cutover candidate health check failed");
    }
    if (await adapter.verifyCandidate({ approval }) !== true) {
      fail("first cutover candidate verification failed");
    }
    await journal(adapter, "healthy", approval);
    await adapter.commitProjection({ approval });
    await journal(adapter, "committed", approval);
    return Object.freeze({
      status: "committed",
      operationId: approval.operationId,
      deploymentUnit: approval.deploymentUnit,
      releaseSha: approval.releaseSha,
    });
  } catch (error) {
    if (!mutationStarted) throw error;
    try {
      await rollback(adapter, approval);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "first production cutover and rollback failed");
    }
    throw new Error("first production cutover failed and rolled back", { cause: error });
  }
}
