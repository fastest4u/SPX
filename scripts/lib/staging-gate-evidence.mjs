import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, validateReleaseBinding } from "./evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
} from "./phase3-staging-evidence.mjs";

const DEFAULT_ROOT = "/var/lib/spx-staging-rollout/evidence/gates";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60_000;
const HASH = /^[0-9a-f]{64}$/;
const ZERO_HASH = "0".repeat(64);
const PROOF_KEYS_V1 = Object.freeze([
  "schemaVersion",
  "gateActionId",
  "proofName",
  "sourceActionId",
  "observedAt",
  "releaseBinding",
  "measurements",
]);
const PROOF_KEYS_V2 = Object.freeze([...PROOF_KEYS_V1, "sourceEvidence"]);
const WRITE_INPUT_KEYS_V1 = Object.freeze([
  "gateActionId",
  "proofName",
  "sourceActionId",
  "binding",
  "observedAt",
  "measurements",
]);
const WRITE_INPUT_KEYS_V2 = Object.freeze([...WRITE_INPUT_KEYS_V1, "sourceEvidence"]);
const PRODUCE_INPUT_KEYS = Object.freeze(["gateActionId", "binding", "capturedAt"]);
const PHASE3_PRODUCE_INPUT_KEYS = Object.freeze([
  "semantic",
  "semanticSha256",
  "sources",
  "binding",
  "capturedAt",
]);
const PHASE3_PRODUCER_PORT_NAMES = Object.freeze(["writeProof", "writeAggregate"]);

const GUARD_MEASUREMENTS = Object.freeze({
  continuityGapMs: 0,
  guardFresh: true,
  watchdogFresh: true,
});
const PRODUCTION_UNCHANGED_MEASUREMENTS = Object.freeze({
  productionDatabaseConnectivityUnchanged: true,
  productionReadinessUnchanged: true,
});

export const PHASE3_GATE4_SOURCE_GRAPH = deepFreeze({
  "schema-verify": ["phase3-schema-marker"],
  "consumer-start-disabled": ["phase3-action:phase3-consumer-start-disabled"],
  "legacy-lease-release": ["phase3-action:phase3-legacy-lease-release"],
  "poller-start": ["phase3-action:phase3-poller-start"],
  "publication-enable": ["phase3-action:phase3-publication-enable"],
  "execution-enable": ["phase3-action:phase3-execution-enable"],
  "publication-fence": ["phase3-action:phase3-publication-fence"],
  "fence-acknowledged": ["phase3-fence-marker"],
  "drain-or-quarantine": [
    "phase3-action:phase3-drain-or-quarantine",
    "phase3-db-final",
  ],
  "inline-owner-restore": ["phase3-action:phase3-inline-owner-restore"],
  "baseline-restored": ["phase3-runtime-final"],
  "phase3-durable-evidence": [
    "phase3-journal-snapshot",
    "phase3-schema-marker",
    "phase3-fence-marker",
    ...PHASE3_ACTION_IDS.map((actionId) => `phase3-action:${actionId}`),
    "phase3-semantic",
  ],
  "release-binding": ["phase3-journal-snapshot", "phase3-schema-marker"],
  "guard-continuity": ["phase3-lease-continuity"],
  "production-unchanged": ["phase3-production-observer", "phase3-capacity"],
});

const phase3GraphUnion = new Set(Object.values(PHASE3_GATE4_SOURCE_GRAPH).flat());
phase3GraphUnion.delete("phase3-semantic");
if (
  phase3GraphUnion.size !== PHASE3_SEMANTIC_SOURCE_IDS.length ||
  PHASE3_SEMANTIC_SOURCE_IDS.some((sourceId) => !phase3GraphUnion.has(sourceId))
) throw new Error("Gate 4 source graph must cover every Task 4 semantic source exactly");

const GATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    actionId: "staging-gate-1-baseline",
    gate: "gate-1",
    proofs: Object.freeze([
      Object.freeze({
        name: "release-binding",
        sourceActionIds: Object.freeze(["staging-gate-1-baseline"]),
        measurements: Object.freeze({
          releaseIdentityMatches: true,
          stagingRunIdMatches: true,
        }),
      }),
      Object.freeze({
        name: "runtime-identities",
        sourceActionIds: Object.freeze(["staging-runtime-start"]),
        measurements: Object.freeze({
          runtimeIdentitiesMatchRelease: true,
          unexpectedRuntimeIdentityCount: 0,
        }),
      }),
      Object.freeze({
        name: "guard-continuity",
        sourceActionIds: Object.freeze(["staging-gate-1-baseline"]),
        measurements: GUARD_MEASUREMENTS,
      }),
      Object.freeze({
        name: "staging-database",
        sourceActionIds: Object.freeze([
          "staging-gate-1-baseline",
          "staging-db-bootstrap-revoke",
        ]),
        measurements: Object.freeze({
          bootstrapPrincipalRevoked: true,
          failedMigrations: 0,
          runningMigrations: 0,
          stagingDatabaseConnected: true,
        }),
      }),
      Object.freeze({
        name: "production-unchanged",
        sourceActionIds: Object.freeze(["staging-gate-1-baseline"]),
        measurements: PRODUCTION_UNCHANGED_MEASUREMENTS,
      }),
    ]),
  }),
  Object.freeze({
    actionId: "staging-gate-2-worker",
    gate: "gate-2",
    proofs: Object.freeze([
      Object.freeze({
        name: "worker-forward",
        sourceActionIds: Object.freeze(["staging-worker-forward-handoff"]),
        measurements: Object.freeze({
          activeOwnerCount: 1,
          expectedOwnerActive: true,
          priorOwnersReleased: true,
        }),
      }),
      Object.freeze({
        name: "worker-reverse",
        sourceActionIds: Object.freeze(["staging-worker-reverse-handoff"]),
        measurements: Object.freeze({
          activeOwnerCount: 1,
          originalOwnerRestored: true,
          temporaryOwnerReleased: true,
        }),
      }),
      Object.freeze({
        name: "lease-fencing",
        sourceActionIds: Object.freeze(["staging-gate-2-worker"]),
        measurements: Object.freeze({
          conflictingLeaseCount: 0,
          leaseFencingValid: true,
        }),
      }),
      Object.freeze({
        name: "watermark-monotonic",
        sourceActionIds: Object.freeze(["staging-gate-2-worker"]),
        measurements: Object.freeze({
          watermarkMonotonic: true,
          watermarkRegressionCount: 0,
        }),
      }),
      Object.freeze({
        name: "guard-continuity",
        sourceActionIds: Object.freeze(["staging-gate-2-worker"]),
        measurements: GUARD_MEASUREMENTS,
      }),
      Object.freeze({
        name: "production-unchanged",
        sourceActionIds: Object.freeze(["staging-gate-2-worker"]),
        measurements: PRODUCTION_UNCHANGED_MEASUREMENTS,
      }),
    ]),
  }),
  Object.freeze({
    actionId: "staging-gate-3-handoff",
    gate: "gate-3",
    proofs: Object.freeze([
      Object.freeze({
        name: "gate-1-handoff",
        sourceActionIds: Object.freeze(["staging-gate-1-baseline"]),
        measurements: Object.freeze({
          gate1EvidenceBound: true,
          stagingRunIdMatches: true,
        }),
      }),
      Object.freeze({
        name: "gate-2-handoff",
        sourceActionIds: Object.freeze(["staging-gate-2-worker"]),
        measurements: Object.freeze({
          continuousGuardLease: true,
          gate2EvidenceBound: true,
        }),
      }),
      Object.freeze({
        name: "gate-3-handoff",
        sourceActionIds: Object.freeze(["staging-gate-3-handoff"]),
        measurements: Object.freeze({
          gate1EvidenceBound: true,
          gate2EvidenceBound: true,
          phase3MutationCount: 0,
        }),
      }),
      Object.freeze({
        name: "release-binding",
        sourceActionIds: Object.freeze(["staging-gate-3-handoff"]),
        measurements: Object.freeze({
          releaseIdentityMatches: true,
          stagingRunIdMatches: true,
        }),
      }),
      Object.freeze({
        name: "guard-continuity",
        sourceActionIds: Object.freeze(["staging-gate-3-handoff"]),
        measurements: GUARD_MEASUREMENTS,
      }),
      Object.freeze({
        name: "production-unchanged",
        sourceActionIds: Object.freeze(["staging-gate-3-handoff"]),
        measurements: PRODUCTION_UNCHANGED_MEASUREMENTS,
      }),
    ]),
  }),
  Object.freeze({
    actionId: "staging-gate-4-phase3",
    gate: "gate-4",
    proofs: Object.freeze([
      Object.freeze({
        name: "schema-verify",
        sourceActionIds: Object.freeze(["phase3-schema-verify"]),
        measurements: Object.freeze({
          candidateSchemaRangeDeclared: true,
          failedMigrations: 0,
          installedSchemaMaximumMatches: true,
          migration035ChecksumMatches: true,
          nMinusOneSchemaRangeDeclared: true,
          observerReadOnly: true,
          pendingMigrations: 0,
          runningMigrations: 0,
        }),
      }),
      Object.freeze({
        name: "consumer-start-disabled",
        sourceActionIds: Object.freeze(["phase3-consumer-start-disabled"]),
        measurements: Object.freeze({
          consumerStarted: true,
          realExecutionDisabled: true,
          settlementDisabled: true,
        }),
      }),
      Object.freeze({
        name: "legacy-lease-release",
        sourceActionIds: Object.freeze(["phase3-legacy-lease-release"]),
        measurements: Object.freeze({
          exactCanaryTeam: true,
          legacyLeaseReleased: true,
        }),
      }),
      Object.freeze({
        name: "poller-start",
        sourceActionIds: Object.freeze(["phase3-poller-start"]),
        measurements: Object.freeze({
          pollerHealthy: true,
          solePublisher: true,
        }),
      }),
      Object.freeze({
        name: "publication-enable",
        sourceActionIds: Object.freeze(["phase3-publication-enable"]),
        measurements: Object.freeze({
          historyPreserved: true,
          priorGenerationSafe: true,
          publicationPointerInitializedOrAdvanced: true,
        }),
      }),
      Object.freeze({
        name: "execution-enable",
        sourceActionIds: Object.freeze(["phase3-execution-enable"]),
        measurements: Object.freeze({
          consumerHealthy: true,
          executionEnabled: true,
        }),
      }),
      Object.freeze({
        name: "publication-fence",
        sourceActionIds: Object.freeze(["phase3-publication-fence"]),
        measurements: Object.freeze({
          fenceWatermarkCaptured: true,
          fencedExactGeneration: true,
        }),
      }),
      Object.freeze({
        name: "fence-acknowledged",
        sourceActionIds: Object.freeze(["phase3-fence-ack-wait"]),
        measurements: Object.freeze({
          acknowledgmentAtOrBeyondFence: true,
          fenceActionTerminal: true,
          observerReadOnly: true,
        }),
      }),
      Object.freeze({
        name: "drain-or-quarantine",
        sourceActionIds: Object.freeze(["phase3-drain-or-quarantine"]),
        measurements: Object.freeze({
          activeWorkCount: 0,
          generationScoped: true,
          settlementPendingCount: 0,
          unknownWorkCount: 0,
        }),
      }),
      Object.freeze({
        name: "inline-owner-restore",
        sourceActionIds: Object.freeze(["phase3-inline-owner-restore"]),
        measurements: Object.freeze({
          canaryRolesStopped: true,
          generationSafe: true,
          inlineOwnerRestored: true,
        }),
      }),
      Object.freeze({
        name: "baseline-restored",
        sourceActionIds: Object.freeze(["phase3-inline-owner-restore"]),
        measurements: Object.freeze({
          baselineRestored: true,
          phase3RuntimeRemainingCount: 0,
        }),
      }),
      Object.freeze({
        name: "phase3-durable-evidence",
        sourceActionIds: Object.freeze(["phase3-inline-owner-restore"]),
        measurements: Object.freeze({
          durableMutationProofCount: 8,
          missingProofCount: 0,
          readOnlyObservationCount: 2,
        }),
      }),
      Object.freeze({
        name: "release-binding",
        sourceActionIds: Object.freeze(["phase3-inline-owner-restore"]),
        measurements: Object.freeze({
          releaseIdentityMatches: true,
          stagingRunIdMatches: true,
        }),
      }),
      Object.freeze({
        name: "guard-continuity",
        sourceActionIds: Object.freeze(["phase3-inline-owner-restore"]),
        measurements: GUARD_MEASUREMENTS,
      }),
      Object.freeze({
        name: "production-unchanged",
        sourceActionIds: Object.freeze(["phase3-inline-owner-restore"]),
        measurements: PRODUCTION_UNCHANGED_MEASUREMENTS,
      }),
    ]),
  }),
]);

export const STAGING_GATE_ACTIONS = Object.freeze(GATE_DEFINITIONS.map((definition) =>
  Object.freeze({
    actionId: definition.actionId,
    scope: definition.gate,
    gate: definition.gate,
    requiredProofs: Object.freeze(definition.proofs.map(({ name }) => name)),
  })
));

export const STAGING_GATE_PROOF_CONTRACTS = Object.freeze(Object.fromEntries(
  GATE_DEFINITIONS.map((definition) => [
    definition.actionId,
    Object.freeze(Object.fromEntries(definition.proofs.map((proof) => [
      proof.name,
      Object.freeze({
        sourceActionIds: proof.sourceActionIds,
        measurements: proof.measurements,
      }),
    ]))),
  ]),
));

export const STAGING_GATE_EVIDENCE_PATHS = Object.freeze(Object.fromEntries(
  GATE_DEFINITIONS.map(({ actionId, gate }) => [actionId, `${DEFAULT_ROOT}/${gate}.json`]),
));

const STAGING_GATE_PROOF_RELATIVE_PATHS = deepFreeze(Object.fromEntries(
  GATE_DEFINITIONS.map(({ actionId, proofs }) => [
    actionId,
    Object.fromEntries(proofs.map(({ name }) => [
      name,
      ["proofs", actionId, `${name}.json`],
    ])),
  ]),
));

export const STAGING_GATE_PROOF_PATHS = deepFreeze(Object.fromEntries(
  Object.entries(STAGING_GATE_PROOF_RELATIVE_PATHS).map(([actionId, proofs]) => [
    actionId,
    Object.fromEntries(Object.entries(proofs).map(([name, segments]) => [
      name,
      join(DEFAULT_ROOT, ...segments),
    ])),
  ]),
));

const ACTIONS = new Map(STAGING_GATE_ACTIONS.map((action) => [action.actionId, action]));

function fixedProofPath(root, gateActionId, proofName) {
  const segments = STAGING_GATE_PROOF_RELATIVE_PATHS[gateActionId]?.[proofName];
  if (!segments) throw new Error("fixed staging gate proof path is invalid");
  return join(root, ...segments);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (
    !isPlainObject(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label} must contain exactly the fixed contract fields`);
  }
}

function resolveNowMs(options) {
  const nowMs = options?.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("staging gate evidence clock is invalid");
  return nowMs;
}

function timestamp(value, nowMs) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed)
    && parsed <= nowMs + MAX_FUTURE_SKEW_MS
    && nowMs - parsed <= MAX_EVIDENCE_AGE_MS;
}

function observationWithinCaptureSkew(observedAt, capturedAt) {
  return Date.parse(observedAt) <= Date.parse(capturedAt) + MAX_FUTURE_SKEW_MS;
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function gateContract(gateActionId, proofName) {
  const action = ACTIONS.get(gateActionId);
  const contract = STAGING_GATE_PROOF_CONTRACTS[gateActionId]?.[proofName];
  if (!action || !contract) throw new Error("fixed staging gate proof contract is invalid");
  return { action, contract };
}

const IMMUTABLE_STAGING_RELEASE_FIELDS = Object.freeze([
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "stagingTargetDescriptorSha256",
  "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256",
  "stagingRunId",
]);

function validateHistoricalGate4Binding(value, installedBinding) {
  const validated = validateReleaseBinding(value);
  validateReleaseBinding(installedBinding);
  if (
    validated.environment !== "staging" ||
    validated.composeProject !== "spx-staging" ||
    IMMUTABLE_STAGING_RELEASE_FIELDS.some((field) =>
      validated[field] !== installedBinding[field])
  ) throw new Error("Gate 4 historical release binding changed");
  return validated;
}

function validateSourceEvidence(value, proofName) {
  const expectedIds = PHASE3_GATE4_SOURCE_GRAPH[proofName];
  if (
    !expectedIds ||
    !Array.isArray(value) ||
    value.length !== expectedIds.length
  ) throw new Error("Gate 4 proof source evidence coverage is invalid");
  for (const [index, source] of value.entries()) {
    assertExactKeys(source, ["id", "sha256"], "Gate 4 proof source evidence");
    if (
      source.id !== expectedIds[index] ||
      typeof source.sha256 !== "string" ||
      !HASH.test(source.sha256) ||
      source.sha256 === ZERO_HASH
    ) throw new Error("Gate 4 proof source evidence identity or hash is invalid");
  }
  return value;
}

export function validateStagingGateProof(
  value,
  installedBinding,
  gateActionId,
  proofName,
  options = {},
) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => key !== "nowMs")) {
    throw new Error("staging gate proof validation options are invalid");
  }
  const { contract } = gateContract(gateActionId, proofName);
  const gate4 = gateActionId === "staging-gate-4-phase3";
  assertExactKeys(value, gate4 ? PROOF_KEYS_V2 : PROOF_KEYS_V1, "staging gate proof");
  if (
    value.schemaVersion !== (gate4 ? 2 : 1)
    || value.gateActionId !== gateActionId
    || value.proofName !== proofName
    || !contract.sourceActionIds.includes(value.sourceActionId)
  ) {
    throw new Error("staging gate proof source or fixed contract identity is invalid");
  }
  const validatedBinding = gate4
    ? validateHistoricalGate4Binding(value.releaseBinding, installedBinding)
    : validateReleaseBinding(value.releaseBinding, installedBinding);
  if (validatedBinding.environment !== "staging" || validatedBinding.composeProject !== "spx-staging") {
    throw new Error("staging gate proof release binding is invalid");
  }
  if (!timestamp(value.observedAt, resolveNowMs(options))) {
    throw new Error("staging gate proof observation timestamp is invalid");
  }
  if (canonicalJson(value.measurements) !== canonicalJson(contract.measurements)) {
    throw new Error("staging gate proof measurements do not match the fixed contract");
  }
  if (gate4) validateSourceEvidence(value.sourceEvidence, proofName);
  return deepFreeze(canonicalClone(value));
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function expectedUid(options) {
  const selected = Object.prototype.hasOwnProperty.call(options, "expectedUid")
    ? options.expectedUid
    : process.platform === "win32"
      ? null
      : 0;
  if (selected !== null && (!Number.isSafeInteger(selected) || selected < 0)) {
    throw new Error("staging gate evidence expected UID is invalid");
  }
  return selected;
}

function artifactOptions(options) {
  if (!isPlainObject(options)) throw new Error("staging gate evidence options are invalid");
  const allowed = new Set(["root", "expectedUid", "nowMs"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new Error("staging gate evidence options are invalid");
  }
  const root = options.root ?? DEFAULT_ROOT;
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) {
    throw new Error("staging gate evidence root must be an absolute path");
  }
  return Object.freeze({
    root: resolve(root),
    expectedUid: expectedUid(options),
    nowMs: resolveNowMs(options),
  });
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertOwner(stat, ownerUid, label) {
  if (process.platform !== "win32" && ownerUid !== null && Number(stat.uid) !== ownerUid) {
    throw new Error(`${label} has invalid ownership`);
  }
}

async function assertSecureDirectory(path, ownerUid) {
  const resolvedPath = resolve(path);
  const stat = await lstat(resolvedPath, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || (process.platform !== "win32" && Number(stat.mode & 0o022n) !== 0)
  ) {
    throw new Error("staging gate evidence directory is insecure");
  }
  assertOwner(stat, ownerUid, "staging gate evidence directory");
  const actualPath = resolve(await realpath(resolvedPath));
  if (!samePath(actualPath, resolvedPath)) {
    throw new Error("staging gate evidence directory must not contain symlinks");
  }
  return stat;
}

async function hardenCreatedDirectory(path, ownerUid) {
  if (process.platform !== "win32") await chmod(path, 0o700);
  const stat = await assertSecureDirectory(path, ownerUid);
  if (process.platform !== "win32" && Number(stat.mode & 0o7777n) !== 0o700) {
    throw new Error("created staging gate evidence directory must use mode 0700");
  }
  return stat;
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw new Error("staging gate durability target is not a directory");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error))) throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureRootDirectory(path, ownerUid) {
  const missing = [];
  let cursor = path;
  while (true) {
    try {
      const anchor = await lstat(cursor, { bigint: true });
      if (anchor.isSymbolicLink() || !anchor.isDirectory()) {
        throw new Error("staging gate evidence root parent is not a real directory");
      }
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      missing.unshift(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("staging gate evidence root is unavailable");
      cursor = parent;
    }
  }
  for (const directory of missing) {
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (created) {
      await hardenCreatedDirectory(directory, ownerUid);
    } else {
      await assertSecureDirectory(directory, ownerUid);
    }
    if (created) await syncDirectory(dirname(directory));
  }
  await assertSecureDirectory(path, ownerUid);
}

async function ensureChildDirectory(parent, name, ownerUid) {
  await assertSecureDirectory(parent, ownerUid);
  const path = join(parent, name);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertSecureDirectory(parent, ownerUid);
  if (created) {
    await hardenCreatedDirectory(path, ownerUid);
  } else {
    await assertSecureDirectory(path, ownerUid);
  }
  if (created) await syncDirectory(parent);
  return path;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertSecureFileStat(stat, ownerUid) {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.size > BigInt(MAX_FILE_BYTES)
    || (process.platform !== "win32" && Number(stat.mode & 0o7777n) !== 0o600)
  ) {
    throw new Error("staging gate evidence file is not a secure regular file");
  }
  assertOwner(stat, ownerUid, "staging gate evidence file");
}

async function readSecureBytes(path, ownerUid) {
  const directory = dirname(path);
  await assertSecureDirectory(directory, ownerUid);
  const before = await lstat(path, { bigint: true });
  assertSecureFileStat(before, ownerUid);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new Error("staging gate evidence symlink is forbidden");
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assertSecureFileStat(opened, ownerUid);
    if (!sameFileSnapshot(before, opened)) {
      throw new Error("staging gate evidence file changed during validation");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileSnapshot(opened, after)
      || BigInt(bytes.byteLength) !== after.size
      || bytes.byteLength > MAX_FILE_BYTES
    ) {
      throw new Error("staging gate evidence file changed during validation");
    }
    await assertSecureDirectory(directory, ownerUid);
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonicalBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not canonical UTF-8 JSON`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (text !== canonicalJson(value)) throw new Error(`${label} must use canonical JSON bytes`);
  return value;
}

async function readExisting(path, ownerUid) {
  try {
    return await readSecureBytes(path, ownerUid);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function publishCanonical(path, value, ownerUid) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const existing = await readExisting(path, ownerUid);
  if (existing !== null) {
    if (!existing.equals(bytes)) throw new Error("staging gate evidence conflicts with existing content");
    return;
  }

  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.pending`,
  );
  let handle;
  let operationFailure = null;
  let concurrentWinner = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(0o600);
    const temporaryStat = await handle.stat({ bigint: true });
    assertSecureFileStat(temporaryStat, ownerUid);
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await link(temporary, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const winner = await readSecureBytes(path, ownerUid);
      if (!winner.equals(bytes)) {
        throw new Error("staging gate evidence conflicts with a concurrent writer");
      }
      concurrentWinner = true;
    }
    if (!concurrentWinner) {
      await syncDirectory(directory);
      const published = await readSecureBytes(path, ownerUid);
      if (!published.equals(bytes)) throw new Error("published staging gate evidence changed");
    }
  } catch (error) {
    operationFailure = error;
  }
  let cleanupFailure = null;
  try {
    await handle?.close();
    let removed = false;
    try {
      await unlink(temporary);
      removed = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (removed) await syncDirectory(directory);
  } catch (error) {
    cleanupFailure = error;
  }
  if (cleanupFailure !== null) throw cleanupFailure;
  if (operationFailure !== null) throw operationFailure;
}

async function proofDirectory(root, gateActionId, ownerUid) {
  if (!ACTIONS.has(gateActionId)) throw new Error("fixed staging gate proof path is invalid");
  await ensureRootDirectory(root, ownerUid);
  const proofs = await ensureChildDirectory(root, "proofs", ownerUid);
  return ensureChildDirectory(proofs, gateActionId, ownerUid);
}

export async function writeStagingGateProof(input, options = {}) {
  const gate4 = input?.gateActionId === "staging-gate-4-phase3";
  assertExactKeys(
    input,
    gate4 ? WRITE_INPUT_KEYS_V2 : WRITE_INPUT_KEYS_V1,
    "staging gate proof input",
  );
  const resolvedOptions = artifactOptions(options);
  const value = {
    schemaVersion: gate4 ? 2 : 1,
    gateActionId: input.gateActionId,
    proofName: input.proofName,
    sourceActionId: input.sourceActionId,
    observedAt: input.observedAt,
    releaseBinding: input.binding,
    measurements: input.measurements,
    ...(gate4 ? { sourceEvidence: input.sourceEvidence } : {}),
  };
  const validated = validateStagingGateProof(
    value,
    input.binding,
    input.gateActionId,
    input.proofName,
    { nowMs: resolvedOptions.nowMs },
  );
  await proofDirectory(
    resolvedOptions.root,
    input.gateActionId,
    resolvedOptions.expectedUid,
  );
  await publishCanonical(
    fixedProofPath(resolvedOptions.root, input.gateActionId, input.proofName),
    validated,
    resolvedOptions.expectedUid,
  );
  return validated;
}

export async function produceStagingGateEvidence(input, options = {}) {
  assertExactKeys(input, PRODUCE_INPUT_KEYS, "staging gate evidence input");
  const action = ACTIONS.get(input.gateActionId);
  if (!action) throw new Error("fixed staging gate action is invalid");
  const resolvedOptions = artifactOptions(options);
  const binding = deepFreeze(canonicalClone(validateReleaseBinding(input.binding)));
  if (binding.environment !== "staging" || binding.composeProject !== "spx-staging") {
    throw new Error("staging gate evidence release binding is invalid");
  }
  if (!timestamp(input.capturedAt, resolvedOptions.nowMs)) {
    throw new Error("staging gate evidence capture timestamp is invalid");
  }
  await proofDirectory(
    resolvedOptions.root,
    action.actionId,
    resolvedOptions.expectedUid,
  );
  const proofs = [];
  for (const proofName of action.requiredProofs) {
    const bytes = await readSecureBytes(
      fixedProofPath(resolvedOptions.root, action.actionId, proofName),
      resolvedOptions.expectedUid,
    );
    const proof = parseCanonicalBytes(bytes, "staging gate proof");
    const validated = validateStagingGateProof(
      proof,
      binding,
      action.actionId,
      proofName,
      { nowMs: resolvedOptions.nowMs },
    );
    if (!observationWithinCaptureSkew(validated.observedAt, input.capturedAt)) {
      throw new Error("staging gate proof observation is after the allowed capture skew");
    }
    proofs.push(Object.freeze({
      name: proofName,
      ok: true,
      observedAt: validated.observedAt,
      evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
    }));
  }
  const evidence = deepFreeze(canonicalClone({
    schemaVersion: 1,
    actionId: action.actionId,
    gate: action.gate,
    stagingRunId: binding.stagingRunId,
    capturedAt: input.capturedAt,
    releaseBinding: binding,
    proofs,
  }));
  await ensureRootDirectory(resolvedOptions.root, resolvedOptions.expectedUid);
  await publishCanonical(
    join(resolvedOptions.root, `${action.gate}.json`),
    evidence,
    resolvedOptions.expectedUid,
  );
  return evidence;
}

function validatePhase3ProducerPorts(callerArguments) {
  if (callerArguments.length === 0) {
    return Object.freeze({
      writeProof: (input) => writeStagingGateProof(input),
      writeAggregate: (input) => produceStagingGateEvidence(input),
    });
  }
  if (process.env.NODE_ENV !== "test" || callerArguments.length !== 1) {
    throw new Error("Gate 4 proof producer test ports are forbidden");
  }
  const ports = callerArguments[0];
  assertExactKeys(ports, PHASE3_PRODUCER_PORT_NAMES, "Gate 4 proof producer ports");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  if (PHASE3_PRODUCER_PORT_NAMES.some((name) =>
    !descriptors[name] ||
    !Object.hasOwn(descriptors[name], "value") ||
    typeof descriptors[name].value !== "function"
  )) throw new Error("Gate 4 proof producer ports must be complete functions");
  return Object.freeze(Object.fromEntries(
    PHASE3_PRODUCER_PORT_NAMES.map((name) => [name, descriptors[name].value]),
  ));
}

function validatePhase3ProofProducerInput(input) {
  assertExactKeys(input, PHASE3_PRODUCE_INPUT_KEYS, "Gate 4 proof producer input");
  assertExactKeys(input.semantic, ["value", "bytes", "sha256"], "Gate 4 semantic source");
  const semanticBytes = canonicalJson(input.semantic.value);
  if (
    typeof input.semantic.bytes !== "string" ||
    input.semantic.bytes !== semanticBytes ||
    typeof input.semantic.sha256 !== "string" ||
    !HASH.test(input.semantic.sha256) ||
    input.semantic.sha256 === ZERO_HASH ||
    createHash("sha256").update(input.semantic.bytes).digest("hex") !== input.semantic.sha256 ||
    input.semanticSha256 !== input.semantic.sha256
  ) throw new Error("fixed Gate 4 semantic source bytes or hash are invalid");
  if (
    !isPlainObject(input.sources) ||
    canonicalJson(Object.keys(input.sources)) !== canonicalJson(PHASE3_SEMANTIC_SOURCE_IDS)
  ) throw new Error("Gate 4 Task 4 source graph is incomplete or reordered");
  for (const sourceId of PHASE3_SEMANTIC_SOURCE_IDS) {
    const sourceSha256 = input.sources[sourceId];
    if (
      typeof sourceSha256 !== "string" ||
      !HASH.test(sourceSha256) ||
      sourceSha256 === ZERO_HASH
    ) throw new Error("Gate 4 Task 4 source hash is invalid");
  }
  const binding = deepFreeze(canonicalClone(validateReleaseBinding(input.binding)));
  if (binding.environment !== "staging" || binding.composeProject !== "spx-staging") {
    throw new Error("Gate 4 proof producer release binding is invalid");
  }
  if (!timestamp(input.capturedAt, Date.now())) {
    throw new Error("Gate 4 proof producer capture timestamp is invalid");
  }
  return deepFreeze(canonicalClone({
    semantic: input.semantic,
    semanticSha256: input.semanticSha256,
    sources: input.sources,
    binding,
    capturedAt: input.capturedAt,
  }));
}

export async function producePhase3Gate4Proofs(input, ...callerArguments) {
  const captured = validatePhase3ProofProducerInput(input);
  const ports = validatePhase3ProducerPorts(callerArguments);
  const gateActionId = "staging-gate-4-phase3";
  const action = ACTIONS.get(gateActionId);
  for (const proofName of action.requiredProofs) {
    const contract = STAGING_GATE_PROOF_CONTRACTS[gateActionId][proofName];
    const sourceEvidence = PHASE3_GATE4_SOURCE_GRAPH[proofName].map((id) => Object.freeze({
      id,
      sha256: id === "phase3-semantic"
        ? captured.semanticSha256
        : captured.sources[id],
    }));
    await ports.writeProof({
      gateActionId,
      proofName,
      sourceActionId: contract.sourceActionIds[0],
      binding: captured.binding,
      observedAt: captured.capturedAt,
      measurements: contract.measurements,
      sourceEvidence,
    });
  }
  return ports.writeAggregate({
    gateActionId,
    binding: captured.binding,
    capturedAt: captured.capturedAt,
  });
}
