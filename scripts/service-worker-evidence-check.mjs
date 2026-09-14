#!/usr/bin/env node
// Worker-only rollout evidence checker. Validation modes are non-mutating and
// print only pass/fail metadata, never raw evidence values.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, readEvidenceBundle, readEvidenceJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";
import { evaluateWorkerEvidence } from "./lib/task9-worker-evaluators.mjs";

const ALLOWED_ROLLOUT_ENVIRONMENTS = ["staging", "supervised-production"];
const ALLOWED_WORKER_ROLES = ["worker", "team-worker"];
const MAX_FUTURE_CHECKED_AT_SKEW_MS = 5 * 60 * 1_000;
const MAX_RUNTIME_NODE_HEARTBEAT_AGE_MS = 120_000;
const PLACEHOLDER_TEXT_PATTERN = /YYYY|HHMM|TODO|TBD|<|>/i;
const DIRECTORY_METADATA_FILE = "drill-metadata.json";
const DIRECTORY_EVIDENCE_FILES = {
  webApiReadyBefore: "web-api-ready-before.json",
  replacementStarted: "replacement-started.json",
  runtimeStatusAfter: "runtime-status-after.json",
  metricsAfter: "metrics-after.json",
  webApiReadyAfter: "web-api-ready-after.json",
};
export const SERVICE_WORKER_EVIDENCE_MANIFEST = Object.freeze({
  [DIRECTORY_METADATA_FILE]: "drillMetadata",
  ...Object.fromEntries(
    Object.entries(DIRECTORY_EVIDENCE_FILES).map(([key, filename]) => [filename, key]),
  ),
});
const UNSAFE_EVIDENCE_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "credential",
  "password",
  "payload",
  "pincode",
  "raw",
  "requestbody",
  "responsebody",
  "secret",
  "stderr",
  "stdout",
  "target",
  "targetid",
  "token",
];
const UNSAFE_EVIDENCE_VALUE_PATTERNS = [
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:secret|token|password|cookie|credential|pincode)\s*[=:]\s*\S+/i,
  /\b[A-Za-z0-9_.-]*(?:secret|token|password|cookie|credential|pincode|api[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*\S+/i,
];

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function rolloutEnvironment() {
  const environment = argValue("environment") ?? "staging";
  if (!ALLOWED_ROLLOUT_ENVIRONMENTS.includes(environment)) {
    throw new Error("unsupported rollout environment");
  }
  return environment;
}

function helpText() {
  return `service-worker-evidence-check.mjs

Worker-only rollout evidence checker. Use it after a staging or supervised
production worker replacement drill to validate sanitized evidence that web/API
readiness stayed healthy, one replacement worker owns each assigned team lease,
and worker runtime metrics kept publishing.

Usage:
  node scripts/service-worker-evidence-check.mjs --help
  node scripts/service-worker-evidence-check.mjs --template
  node scripts/service-worker-evidence-check.mjs --dir-manifest
  node scripts/service-worker-evidence-check.mjs --init-dir=<evidence-folder>
  node scripts/service-worker-evidence-check.mjs --dir-status=<evidence-folder>
  node scripts/service-worker-evidence-check.mjs --dir=<evidence-folder>
  node scripts/service-worker-evidence-check.mjs --handoff-dir=<evidence-folder>

Use --environment=staging or --environment=supervised-production for every
directory command. The default remains staging for backward compatibility.

Evidence is operator-supplied JSON from safe dashboard/API observations and
manual timestamped notes. Output is pass/fail metadata only; raw evidence,
logs, targets, payloads, and secret-shaped fields are never echoed.
`;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function evidenceTemplate() {
  return {
    drillId: "worker-only-drill-YYYYMMDD-HHMM",
    environment: rolloutEnvironment(),
    note: "Paste sanitized staging or supervised-production worker-only drill evidence.",
    webApiReadyBefore: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "web-api-ready",
      note: "Record a safe web/API readiness observation before replacing the worker.",
    },
    replacementStarted: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "worker-replacement-started",
      teamIds: [1],
      oldNodeId: "previous-worker-node-id",
      newNodeId: "replacement-worker-node-id",
      note: "Record the explicit RUN_TEAM_IDS used by the replacement worker.",
    },
    runtimeStatusAfter: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      expectedTeamIds: [1],
      expectedOwnerNodeId: "replacement-worker-node-id",
      leases: [
        {
          teamId: 1,
          ownerNodeId: "replacement-worker-node-id",
          ownerRole: "worker",
          active: true,
          heartbeatAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
          leaseExpiresAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
        },
      ],
      nodes: [
        {
          nodeId: "replacement-worker-node-id",
          role: "worker",
          lastHeartbeatAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
        },
      ],
    },
    metricsAfter: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "worker-metrics-publishing",
      successCount: 1,
      failureCount: 0,
      note: "Record a safe metric-publishing observation after worker replacement.",
    },
    webApiReadyAfter: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "web-api-ready",
      note: "Record a safe web/API readiness observation after replacing the worker.",
    },
  };
}

function evidenceDirectoryManifest() {
  return { ...SERVICE_WORKER_EVIDENCE_MANIFEST };
}

function evidenceDirectoryEntries() {
  const template = evidenceTemplate();
  return [
    {
      file: DIRECTORY_METADATA_FILE,
      key: "drillMetadata",
      value: {
        drillId: template.drillId,
        environment: template.environment,
        note: template.note,
      },
    },
    ...Object.entries(DIRECTORY_EVIDENCE_FILES).map(([key, file]) => ({
      file,
      key,
      value: template[key],
    })),
  ];
}

function isPlaceholderEvidence(key, value) {
  const entry = evidenceDirectoryEntries().find((candidate) => candidate.key === key);
  return Boolean(entry && canonicalJson(value) === canonicalJson(entry.value));
}

function safeErrorReason() {
  return "worker-evidence-check-failed";
}

function hasConcreteString(value) {
  return typeof value === "string" && value.trim() !== "" && !PLACEHOLDER_TEXT_PATTERN.test(value);
}

function hasNoUnsafeEvidenceFields(value) {
  if (Array.isArray(value)) return value.every((item) => hasNoUnsafeEvidenceFields(item));
  if (typeof value === "string") {
    return !UNSAFE_EVIDENCE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (!isObject(value)) return true;
  return Object.entries(value).every(([key, childValue]) => {
    const normalizedKey = key.toLowerCase();
    if (UNSAFE_EVIDENCE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))) {
      return false;
    }
    return hasNoUnsafeEvidenceFields(childValue);
  });
}

function timestampMs(value) {
  if (!isObject(value) || typeof value.checkedAt !== "string") return null;
  const parsed = Date.parse(value.checkedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidCheckedAt(value) {
  const checkedAtMs = timestampMs(value);
  return checkedAtMs !== null && checkedAtMs <= Date.now() + MAX_FUTURE_CHECKED_AT_SKEW_MS;
}

function happensBeforeOrAt(first, second) {
  const firstMs = timestampMs(first);
  const secondMs = timestampMs(second);
  if (firstMs === null || secondMs === null) return false;
  return firstMs <= secondMs;
}

function hasDrillMetadata(value) {
  return (
    isObject(value) &&
    hasConcreteString(value.drillId) &&
    typeof value.environment === "string" &&
    ALLOWED_ROLLOUT_ENVIRONMENTS.includes(value.environment)
  );
}

function isManualCheck(value, evidenceType) {
  return (
    isObject(value) &&
    value.ok === true &&
    value.evidenceType === evidenceType &&
    typeof value.note === "string" &&
    value.note.trim() !== "" &&
    hasValidCheckedAt(value)
  );
}

function positiveIntegerArray(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const numbers = value.filter((item) => Number.isInteger(item) && item > 0);
  if (numbers.length !== value.length) return null;
  return [...new Set(numbers)];
}

function hasSameIds(left, right) {
  const leftIds = positiveIntegerArray(left);
  const rightIds = positiveIntegerArray(right);
  if (!leftIds || !rightIds || leftIds.length !== rightIds.length) return false;
  const rightSet = new Set(rightIds);
  return leftIds.every((id) => rightSet.has(id));
}

function hasReplacementStarted(value) {
  return (
    isManualCheck(value, "worker-replacement-started") &&
    positiveIntegerArray(value.teamIds) !== null &&
    hasConcreteString(value.newNodeId) &&
    (value.oldNodeId === undefined || hasConcreteString(value.oldNodeId))
  );
}

function validDateString(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function hasValidLeaseTiming(lease, checkedAtMs) {
  if (!validDateString(lease.heartbeatAt) || !validDateString(lease.leaseExpiresAt)) return false;
  const heartbeatAtMs = Date.parse(lease.heartbeatAt);
  const leaseExpiresAtMs = Date.parse(lease.leaseExpiresAt);
  return heartbeatAtMs < leaseExpiresAtMs && leaseExpiresAtMs > checkedAtMs;
}

function hasRuntimeLeaseOwnership(evidence) {
  const runtime = evidence.runtimeStatusAfter;
  const replacement = evidence.replacementStarted;
  if (
    !isObject(runtime) ||
    runtime.ok !== true ||
    !hasValidCheckedAt(runtime) ||
    !hasReplacementStarted(replacement) ||
    !hasSameIds(runtime.expectedTeamIds, replacement.teamIds) ||
    runtime.expectedOwnerNodeId !== replacement.newNodeId ||
    !Array.isArray(runtime.leases) ||
    !Array.isArray(runtime.nodes)
  ) {
    return false;
  }

  const expectedTeamIds = positiveIntegerArray(runtime.expectedTeamIds);
  if (!expectedTeamIds) return false;
  const checkedAtMs = timestampMs(runtime);
  if (checkedAtMs === null) return false;
  const activeLeases = runtime.leases.filter((lease) => isObject(lease) && lease.active === true);
  const ownerNode = runtime.nodes.find(
    (node) =>
      isObject(node) &&
      node.nodeId === runtime.expectedOwnerNodeId &&
      ALLOWED_WORKER_ROLES.includes(node.role) &&
      validDateString(node.lastHeartbeatAt) &&
      Date.parse(node.lastHeartbeatAt) <= checkedAtMs &&
      checkedAtMs - Date.parse(node.lastHeartbeatAt) <= MAX_RUNTIME_NODE_HEARTBEAT_AGE_MS,
  );
  if (!ownerNode) return false;

  return expectedTeamIds.every((teamId) => {
    const matchingLeases = activeLeases.filter((lease) => lease.teamId === teamId);
    if (matchingLeases.length !== 1) return false;
    const [lease] = matchingLeases;
    return (
      lease.ownerNodeId === runtime.expectedOwnerNodeId &&
      ALLOWED_WORKER_ROLES.includes(lease.ownerRole) &&
      hasValidLeaseTiming(lease, checkedAtMs)
    );
  });
}

function hasMetricsPublishing(value) {
  return (
    isManualCheck(value, "worker-metrics-publishing") &&
    Number.isInteger(value.successCount) &&
    value.successCount > 0 &&
    Number.isInteger(value.failureCount) &&
    value.failureCount === 0
  );
}

function hasOrderedEvidence(evidence) {
  return (
    hasValidCheckedAt(evidence.webApiReadyBefore) &&
    hasValidCheckedAt(evidence.replacementStarted) &&
    hasValidCheckedAt(evidence.runtimeStatusAfter) &&
    hasValidCheckedAt(evidence.metricsAfter) &&
    hasValidCheckedAt(evidence.webApiReadyAfter) &&
    happensBeforeOrAt(evidence.webApiReadyBefore, evidence.replacementStarted) &&
    happensBeforeOrAt(evidence.replacementStarted, evidence.runtimeStatusAfter) &&
    happensBeforeOrAt(evidence.runtimeStatusAfter, evidence.metricsAfter) &&
    happensBeforeOrAt(evidence.metricsAfter, evidence.webApiReadyAfter)
  );
}

const checks = [
  {
    name: "drillMetadata",
    description: "Evidence names a concrete staging or supervised production worker drill.",
    verify: (evidence) => hasDrillMetadata(evidence),
  },
  {
    name: "sanitizedEvidence",
    description: "Evidence contains sanitized observations, not raw logs, payloads, or secrets.",
    verify: (evidence) => hasNoUnsafeEvidenceFields(evidence),
  },
  {
    name: "evidenceOrder",
    description: "Worker replacement evidence timestamps are non-future and in drill order.",
    verify: (evidence) => hasOrderedEvidence(evidence),
  },
  {
    name: "webApiReadyBefore",
    description: "Web/API readiness was healthy before worker replacement.",
    verify: (evidence) => isManualCheck(evidence.webApiReadyBefore, "web-api-ready"),
  },
  {
    name: "replacementStarted",
    description: "Replacement worker start evidence names explicit team assignments and node id.",
    verify: (evidence) => hasReplacementStarted(evidence.replacementStarted),
  },
  {
    name: "runtimeLeaseOwnership",
    description: "Exactly one active lease per expected team is owned by the replacement worker.",
    verify: (evidence) => hasRuntimeLeaseOwnership(evidence),
  },
  {
    name: "metricsPublishing",
    description: "Worker runtime metrics continued publishing after replacement.",
    verify: (evidence) => hasMetricsPublishing(evidence.metricsAfter),
  },
  {
    name: "webApiReadyAfter",
    description: "Web/API readiness was healthy after worker replacement.",
    verify: (evidence) => isManualCheck(evidence.webApiReadyAfter, "web-api-ready"),
  },
];

function evidenceDirectoryFilenames() {
  return [DIRECTORY_METADATA_FILE, ...Object.values(DIRECTORY_EVIDENCE_FILES)];
}

function boundPayload(value) {
  if (
    !isObject(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(["payload", "releaseBinding"])
  ) {
    throw new Error("verified release binding wrapper is required");
  }
  return value.payload;
}

async function readBoundEvidenceFiles(dir, options = {}) {
  const expectedBinding = await loadInstalledReleaseBinding({ environment: rolloutEnvironment() });
  return readEvidenceBundle(dir, {
    allowedNames: evidenceDirectoryFilenames(),
    expectedBinding,
    maxTotalBytes: 2 * 1024 * 1024,
    requireAll: options.requireAll,
    rejectPlaceholders: options.rejectPlaceholders,
  });
}

function assembleBoundEvidence(files) {
  const metadata = boundPayload(files[DIRECTORY_METADATA_FILE]);
  const evidence = { ...metadata };
  for (const [key, file] of Object.entries(DIRECTORY_EVIDENCE_FILES)) {
    evidence[key] = boundPayload(files[file]);
  }
  return evidence;
}

async function loadEvidenceDirectory(dir) {
  const evidence = assembleBoundEvidence(await readBoundEvidenceFiles(dir));
  if (evidence.environment !== rolloutEnvironment()) {
    throw new Error("evidence environment does not match the installed release binding");
  }
  return evidence;
}

async function loadHandoffEvidenceDirectory(dir) {
  const expectedBinding = await loadInstalledReleaseBinding({ environment: "staging" });
  const files = await readEvidenceBundle(dir, {
    allowedNames: ["handoff-evidence.json"],
    expectedBinding,
    maxTotalBytes: 256 * 1024,
  });
  return boundPayload(files["handoff-evidence.json"]);
}

async function initEvidenceDirectory(dir) {
  const releaseBinding = await loadInstalledReleaseBinding({ environment: rolloutEnvironment() });
  await mkdir(dir, { recursive: true });
  const existingFiles = await readdir(dir);
  if (existingFiles.length > 0) {
    throw new Error("--init-dir target must be empty");
  }

  const entries = evidenceDirectoryEntries();
  for (const entry of entries) {
    await writeFile(
      join(dir, entry.file),
      canonicalJson({ payload: entry.value, releaseBinding }),
      "utf8",
    );
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    files: entries.map((entry) => entry.file),
  };
}

function readDirectoryEntryStatus(boundFiles, entry) {
  try {
    if (!(entry.file in boundFiles)) {
      return { file: entry.file, key: entry.key, ready: false, reason: "missing" };
    }
    const value = boundPayload(boundFiles[entry.file]);
    if (isPlaceholderEvidence(entry.key, value)) {
      return { file: entry.file, key: entry.key, ready: false, reason: "placeholder" };
    }
    return { file: entry.file, key: entry.key, ready: true, reason: null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { file: entry.file, key: entry.key, ready: false, reason: "missing" };
    }
    return { file: entry.file, key: entry.key, ready: false, reason: "invalid-json" };
  }
}

function summarizeSemanticStatus(result) {
  return {
    ok: result.ok,
    totalChecks: result.totalChecks,
    passedChecks: result.passedChecks,
    failedChecks: result.failedChecks,
    nextFailedCheck: result.failedChecks[0] ?? null,
  };
}

async function evidenceDirectoryStatus(dir) {
  const boundFiles = await readBoundEvidenceFiles(dir, {
    requireAll: false,
    rejectPlaceholders: false,
  });
  const entries = evidenceDirectoryEntries();
  const files = [];
  for (const entry of entries) {
    files.push(readDirectoryEntryStatus(boundFiles, entry));
  }

  const readyFiles = files.filter((file) => file.ready).length;
  const nextRequired = files.find((file) => !file.ready) ?? null;
  let semanticStatus = null;
  if (readyFiles === files.length) {
    try {
      semanticStatus = summarizeSemanticStatus(
        evaluateServiceWorkerEvidence(assembleBoundEvidence(boundFiles)),
      );
    } catch {
      semanticStatus = {
        ok: false,
        totalChecks: checks.length,
        passedChecks: 0,
        failedChecks: ["invalidDirectoryEvidence"],
        nextFailedCheck: "invalidDirectoryEvidence",
      };
    }
  }

  const ok = readyFiles === files.length && semanticStatus?.ok === true;
  return {
    ok,
    checkedAt: new Date().toISOString(),
    totalFiles: files.length,
    readyFiles,
    missingFiles: files.filter((file) => file.reason === "missing").map((file) => file.file),
    invalidJsonFiles: files
      .filter((file) => file.reason === "invalid-json")
      .map((file) => file.file),
    placeholderFiles: files
      .filter((file) => file.reason === "placeholder")
      .map((file) => ({ file: file.file, key: file.key })),
    nextRequiredEvidence: nextRequired
      ? { file: nextRequired.file, key: nextRequired.key, reason: nextRequired.reason }
      : null,
    semanticStatus,
  };
}

async function loadEvidence() {
  const fixtureJson = argValue("fixture-json");
  if (fixtureJson) {
    if (globalThis.__SPX_TEST_ALLOW_UNBOUND_EVIDENCE__ !== true) {
      throw new Error("unbound fixture evidence is unavailable");
    }
    return JSON.parse(fixtureJson);
  }
  const dir = argValue("dir");
  if (dir) return loadEvidenceDirectory(dir);
  const handoffDir = argValue("handoff-dir");
  if (handoffDir) return loadHandoffEvidenceDirectory(handoffDir);
  const file = argValue("file");
  if (file && globalThis.__SPX_TEST_ALLOW_UNBOUND_EVIDENCE__ !== true) {
    throw new Error("production evidence must use a verified bound directory");
  }
  if (!file) {
    throw new Error("Provide --dir=<evidence-folder>");
  }
  return readEvidenceJson(file);
}

export function evaluateServiceWorkerEvidence(evidence) {
  if (!isObject(evidence)) throw new Error("Evidence must be a JSON object");
  if ("isolationModel" in evidence) {
    const checked = evaluateWorkerEvidence(evidence);
    const failures = [...checked.failures];
    if (!hasNoUnsafeEvidenceFields(evidence)) failures.push("UNSAFE_EVIDENCE_FIELDS");
    const failedChecks = [...new Set(failures)];
    return {
      ok: failedChecks.length === 0,
      checkedAt: new Date().toISOString(),
      totalChecks: 1,
      passedChecks: failedChecks.length === 0 ? 1 : 0,
      failedChecks,
      checks: [
        {
          name: "bidirectionalSameHostHandoff",
          ok: failedChecks.length === 0,
          description: "Same-host forward and reverse handoffs preserve fencing and watermarks.",
        },
      ],
    };
  }
  const results = checks.map((check) => {
    let ok = false;
    try {
      ok = check.verify(evidence);
    } catch {
      ok = false;
    }
    return {
      name: check.name,
      ok,
      description: check.description,
    };
  });
  const failedChecks = results.filter((result) => !result.ok).map((result) => result.name);
  return {
    ok: failedChecks.length === 0,
    checkedAt: new Date().toISOString(),
    totalChecks: results.length,
    passedChecks: results.length - failedChecks.length,
    failedChecks,
    checks: results,
  };
}

async function main() {
if (hasFlag("help")) {
  console.log(helpText());
} else if (hasFlag("template")) {
  console.log(JSON.stringify(evidenceTemplate(), null, 2));
} else if (hasFlag("dir-manifest")) {
  console.log(JSON.stringify(evidenceDirectoryManifest(), null, 2));
} else if (argValue("init-dir")) {
  try {
    console.log(JSON.stringify(await initEvidenceDirectory(argValue("init-dir")), null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: safeErrorReason(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
} else if (argValue("dir-status")) {
  try {
    const status = await evidenceDirectoryStatus(argValue("dir-status"));
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: safeErrorReason(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
} else {
  try {
    const evidence = await loadEvidence();
    const result = evaluateServiceWorkerEvidence(evidence);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: safeErrorReason(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
