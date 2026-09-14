#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPENSATION_PAIRINGS,
  EMERGENCY_SCOPES,
  MANDATORY_FORWARD_SCOPES,
  canonicalGate6Json,
} from "../src/services/gate6-approval-runtime.mjs";
import {
  beginProductionMutationGate6Handoff,
  readProductionMutationLock,
  reconcileProductionMutationGate6Handoff,
} from "./production-mutation-host-lock.mjs";
import {
  parseGate6ControllerArgs,
  runVerifiedGate6AtomicController,
  runVerifiedGate6ControllerReadOnly,
} from "./lib/gate6-cli-runtime.mjs";
import { readEvidenceBytes } from "./lib/evidence-artifact.mjs";
import { writeGate6RuntimeContext } from "./lib/gate6-runtime-context.mjs";
import {
  buildGate6SemanticReceipt,
  readGate6SemanticReceipt,
  writeGate6SemanticReceipt,
} from "./lib/gate6-semantic-receipt.mjs";
import {
  gate6InstanceUnit,
  verifyGate6CandidateRelease,
  verifyGate6SupervisorInstall,
} from "./lib/gate6-immutable-runtime.mjs";
import { verifyGate6PostProofBundle } from "./lib/gate6-postproof-actions.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const HOST_GATE6_LEASE_OWNER = "systemd:spx-gate6-supervisor";
const HOST_GATE6_LEASE_MS = 30_000;
const INITIAL_LEASE_MS = 15_000;
const CHECKER_TIMEOUT_MS = 120_000;
const FINAL_VERIFIER_FILE = "/var/lib/spx-production-rollout/evidence/final-verifier.json";
const POSTPROOF_BUNDLE_FILE = "/var/lib/spx-gate6/postproof/postproof-actions.json";

const DB_ACTIONS = Object.freeze([
  "db-principal-prepare-realtime",
  "db-principal-prepare-line",
  "db-principal-prepare-notification",
  "db-principal-prepare-worker-ifn",
  "db-principal-prepare-worker-ptwl",
  "db-principal-prepare-web",
  "db-principal-prepare-phase3-control",
  "db-principal-verify-migrator",
  "db-principal-switch-realtime",
  "db-principal-switch-line",
  "db-principal-switch-notification",
  "db-principal-switch-worker-ifn",
  "db-principal-switch-worker-ptwl",
  "db-principal-switch-web",
]);
const TASK9_ACTIONS = Object.freeze([
  "task9-line-baseline",
  "task9-line-boundary",
  "task9-ocr-boundary",
]);
const WORKER_ACTIONS = Object.freeze([
  "worker-ifn-forward",
  "worker-ifn-reverse",
  "worker-ptwl-forward",
  "worker-ptwl-reverse",
]);
const PHASE3_ACTIONS = Object.freeze([
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-fence-ack-wait",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
]);
const PHASE4_ACTIONS = Object.freeze([
  "phase4-verify-expand-install",
  "phase4-realtime-start",
  "phase4-route-producer",
  "phase4-route-read",
  "phase4-route-stream",
  "phase4-route-local-rollback",
  "phase4-route-approved-final",
]);

const SEMANTIC_ACTIONS = Object.freeze({
  "verify-db-transition": Object.freeze({
    scope: "stage-accept-db-transition",
    expectedStage: "admitted",
    nextStage: "db-transition-stable",
    checkerName: "db-transition-production-evidence",
    script: "scripts/production-db-transition-evidence-check.mjs",
    evidenceDirectory: "/var/lib/spx-production-rollout/evidence/db-transition",
    arguments: [
      "--supervised-production",
      "--dir=/var/lib/spx-production-rollout/evidence/db-transition",
    ],
  }),
  "verify-task9": Object.freeze({
    scope: "stage-accept-task9",
    expectedStage: "db-transition-stable",
    nextStage: "task9-accepted",
    checkerName: "task9-production-evidence",
    script: "scripts/service-fault-evidence-check.mjs",
    evidenceDirectory: "/var/lib/spx-production-rollout/evidence/task9-production",
    arguments: ["--dir=/var/lib/spx-production-rollout/evidence/task9-production"],
  }),
  "verify-worker": Object.freeze({
    scope: "stage-accept-worker",
    expectedStage: "task9-accepted",
    nextStage: "worker-accepted",
    checkerName: "worker-production-evidence",
    script: "scripts/service-worker-evidence-check.mjs",
    evidenceDirectory: "/var/lib/spx-production-rollout/evidence/worker-production",
    arguments: ["--dir=/var/lib/spx-production-rollout/evidence/worker-production"],
  }),
  "verify-phase3": Object.freeze({
    scope: "stage-accept-phase3",
    expectedStage: "worker-accepted",
    nextStage: "phase3-accepted",
    checkerName: "phase3-production-evidence",
    script: "scripts/phase3-rollout-evidence-check.mjs",
    evidenceDirectory: "/var/lib/spx-production-rollout/evidence/phase3-production",
    arguments: [
      "--supervised-production",
      "--dir=/var/lib/spx-production-rollout/evidence/phase3-production",
    ],
  }),
  "verify-phase4": Object.freeze({
    scope: "stage-accept-phase4",
    expectedStage: "phase3-accepted",
    nextStage: "phase4-accepted",
    checkerName: "phase4-production-evidence",
    script: "scripts/phase4-rollout-evidence-check.mjs",
    evidenceDirectory: "/var/lib/spx-production-rollout/evidence/phase4-production",
    arguments: [
      "--supervised-production",
      "--dir=/var/lib/spx-production-rollout/evidence/phase4-production",
    ],
  }),
  "verify-pre-close": Object.freeze({
    scope: "stage-accept-pre-close",
    expectedStage: "final-baseline-stable",
    nextStage: "pre-close-accepted",
    checkerName: "pre-close-production-evidence",
    script: "scripts/production-canary-evidence-check.mjs",
    evidenceDirectory: "/var/lib/spx-production-rollout/evidence/pre-close",
    arguments: [
      "--phase=pre-close",
      "--evidence=/var/lib/spx-production-rollout/evidence/pre-close/production-evidence.json",
    ],
  }),
});

const ACTIONS = Object.freeze([
  "status",
  "admit-and-supervise",
  ...Object.keys(SEMANTIC_ACTIONS),
  "register-postproof",
  "abort",
  "seal-close",
  "release",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function actionByScope(envelope, scope) {
  const matches = envelope.actionApprovals.filter((action) => action.scope === scope);
  if (matches.length !== 1)
    throw new Error(`Gate 6 action scope is missing or ambiguous: ${scope}`);
  return matches[0];
}

function chainedDescriptors(envelope, scopes, requiredStage, firstPredecessorScope) {
  let predecessor = actionByScope(envelope, firstPredecessorScope).actionId;
  return scopes.map((scope) => {
    const action = actionByScope(envelope, scope);
    const descriptor = { action, requiredStage, predecessorActionIds: [predecessor] };
    predecessor = action.actionId;
    return descriptor;
  });
}

export function buildGate6AdmissionActions(envelope) {
  if (!Array.isArray(envelope?.actionApprovals))
    throw new Error("Gate 6 action approvals are missing");
  const graph = new Map();
  const add = (action, requiredStage, predecessorActionIds) => {
    if (graph.has(action.scope)) throw new Error("Gate 6 action graph contains a duplicate scope");
    graph.set(action.scope, { action, requiredStage, predecessorActionIds });
  };
  const admit = actionByScope(envelope, "gate6-admit");
  add(admit, "admitted", []);
  const groups = [
    {
      actions: DB_ACTIONS,
      stage: "admitted",
      entry: "gate6-admit",
      accept: "stage-accept-db-transition",
    },
    {
      actions: TASK9_ACTIONS,
      stage: "db-transition-stable",
      entry: "stage-accept-db-transition",
      accept: "stage-accept-task9",
    },
    {
      actions: WORKER_ACTIONS,
      stage: "task9-accepted",
      entry: "stage-accept-task9",
      accept: "stage-accept-worker",
    },
    {
      actions: PHASE3_ACTIONS,
      stage: "worker-accepted",
      entry: "stage-accept-worker",
      accept: "stage-accept-phase3",
    },
    {
      actions: PHASE4_ACTIONS,
      stage: "phase3-accepted",
      entry: "stage-accept-phase3",
      accept: "stage-accept-phase4",
    },
  ];
  for (const group of groups) {
    const descriptors = chainedDescriptors(envelope, group.actions, group.stage, group.entry);
    for (const descriptor of descriptors)
      add(descriptor.action, descriptor.requiredStage, descriptor.predecessorActionIds);
    add(actionByScope(envelope, group.accept), group.stage, [descriptors.at(-1).action.actionId]);
  }
  add(actionByScope(envelope, "gate6-final-baseline"), "phase4-accepted", [
    actionByScope(envelope, "stage-accept-phase4").actionId,
  ]);
  add(actionByScope(envelope, "stage-accept-pre-close"), "final-baseline-stable", [
    actionByScope(envelope, "gate6-final-baseline").actionId,
  ]);
  add(actionByScope(envelope, "gate6-seal-close"), "pre-close-accepted", [
    actionByScope(envelope, "stage-accept-pre-close").actionId,
  ]);
  add(actionByScope(envelope, "gate6-release"), "sealed-verifying", [
    actionByScope(envelope, "gate6-seal-close").actionId,
  ]);
  for (const [scope, pairedScope] of Object.entries(COMPENSATION_PAIRINGS)) {
    const action = actionByScope(envelope, scope);
    if (action.pairedActionId !== actionByScope(envelope, pairedScope).actionId) {
      throw new Error(`Gate 6 compensation pairing is invalid: ${scope}`);
    }
    add(action, "revoked", []);
  }
  for (const scope of EMERGENCY_SCOPES) add(actionByScope(envelope, scope), "admitted", []);
  const expectedScopes = new Set([
    ...MANDATORY_FORWARD_SCOPES,
    ...Object.keys(COMPENSATION_PAIRINGS),
    ...EMERGENCY_SCOPES,
  ]);
  if (
    graph.size !== expectedScopes.size ||
    [...graph.keys()].some((scope) => !expectedScopes.has(scope))
  ) {
    throw new Error("Gate 6 action graph is incomplete");
  }
  return envelope.actionApprovals.map((action) => {
    const descriptor = graph.get(action.scope);
    if (!descriptor) throw new Error(`Gate 6 action graph has no scope: ${action.scope}`);
    return Object.freeze({
      scope: action.scope,
      actionId: action.actionId,
      approvalSha256: sha256(canonicalGate6Json(action)),
      allowedMutationSha256: action.allowedMutationSha256,
      kind: action.kind,
      pairedActionId: action.pairedActionId ?? null,
      predecessorActionIds: [...descriptor.predecessorActionIds],
      requiredStage: descriptor.requiredStage,
      requiredCheckerSha256: null,
      expiresAt: action.expiresAt,
    });
  });
}

export function parseGate6RuntimeControlArgs(argv) {
  const parsed = parseGate6ControllerArgs(argv, {
    actions: ACTIONS,
    readOnlyActions: ["status", "register-postproof"],
    extraArguments: ["operation-id", "evidence-dir", "final-verifier", "postproof-bundle"],
  });
  if (parsed.action === "admit-and-supervise") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed["operation-id"] ?? "")) {
      throw new Error("Gate 6 admission operation ID is required");
    }
  } else if (parsed["operation-id"]) throw new Error("Gate 6 operation ID is admission-only");
  const semantic = SEMANTIC_ACTIONS[parsed.action];
  if (semantic) {
    if (resolve(parsed["evidence-dir"] ?? "") !== semantic.evidenceDirectory) {
      throw new Error("Gate 6 evidence directory is not the fixed approved path");
    }
  } else if (parsed["evidence-dir"])
    throw new Error("Gate 6 evidence directory is semantic-checker-only");
  if (parsed.action === "release") {
    if (resolve(parsed["final-verifier"] ?? "") !== FINAL_VERIFIER_FILE) {
      throw new Error("Gate 6 final verifier is not the fixed approved artifact");
    }
  } else if (parsed["final-verifier"]) throw new Error("Gate 6 final verifier is release-only");
  if (parsed.action === "register-postproof") {
    if (
      resolve(parsed["postproof-bundle"] ?? "") !== resolve(POSTPROOF_BUNDLE_FILE) ||
      parsed["action-approval"]
    )
      throw new Error("Gate 6 post-proof registration requires only the fixed signed bundle");
  } else if (parsed["postproof-bundle"])
    throw new Error("Gate 6 post-proof bundle is registration-only");
  return parsed;
}

function exactProtectedBinding(lock, envelope, operationId) {
  const binding = lock?.protectedInstall;
  if (
    lock?.operationId !== operationId ||
    lock?.targetHash !== envelope.productionTargetDescriptorSha256 ||
    !["installed-awaiting-gate6", "handoff-pending"].includes(lock?.state) ||
    binding?.operationId !== operationId ||
    binding?.protectedInstallEvidenceSha256 !== envelope.protectedInstallEvidenceSha256 ||
    binding?.releaseSha !== envelope.candidateSha ||
    binding?.targetDescriptorSha256 !== envelope.productionTargetDescriptorSha256 ||
    binding?.operatorBundleSha256 !== envelope.operatorBundleSha256 ||
    binding?.installedMigrationSetSha256 !== envelope.installedMigrationSetSha256 ||
    binding?.installedSchemaVersion !== envelope.installedSchemaVersion ||
    !SHA256.test(binding?.transferTokenSha256 ?? "") ||
    !Number.isSafeInteger(binding?.slotVersion)
  )
    throw new Error("Gate 6 protected-install host binding is invalid");
  return binding;
}

function hostLockDefaults() {
  return {
    read: () => readProductionMutationLock(),
    begin: (input) => beginProductionMutationGate6Handoff(input),
    reconcile: (input) => reconcileProductionMutationGate6Handoff(input),
  };
}

export async function executeGate6Admission(input) {
  const { artifacts, ledger, operationId } = input;
  if (artifacts.action?.scope !== "gate6-admit")
    throw new Error("Gate 6 admission approval scope is invalid");
  const now = input.now ?? new Date();
  const host = input.hostLockAdapters ?? hostLockDefaults();
  let lock = await host.read();
  const binding = exactProtectedBinding(lock, artifacts.envelope, operationId);
  let slot = await ledger.getProductionSlotForHandoff();
  if (lock.state === "installed-awaiting-gate6") {
    if (
      slot.owner_type !== "protected-install" ||
      slot.owner_id !== operationId ||
      slot.operation_id !== operationId ||
      slot.transfer_token_sha256 !== binding.transferTokenSha256 ||
      slot.state !== "installed-awaiting-gate6" ||
      Number(slot.version) !== binding.slotVersion
    )
      throw new Error("Gate 6 protected-install slot binding is invalid");
    lock = await host.begin({
      operationId,
      releaseHash: lock.releaseHash,
      targetHash: lock.targetHash,
      leaseOwner: lock.lease.owner,
      gate6Id: artifacts.envelope.gate6Id,
      transferTokenSha256: binding.transferTokenSha256,
      expectedSlotVersion: binding.slotVersion,
      nowMs: now.getTime(),
    });
  } else if (
    lock.handoff?.gate6Id !== artifacts.envelope.gate6Id ||
    lock.handoff?.transferTokenSha256 !== binding.transferTokenSha256 ||
    lock.handoff?.expectedSlotVersion !== binding.slotVersion
  )
    throw new Error("Gate 6 pending host handoff is invalid");

  let admitted;
  if (slot.owner_type === "protected-install") {
    const recoveryExpiries = artifacts.envelope.actionApprovals
      .filter((action) => action.kind !== "forward")
      .map((action) => Date.parse(action.expiresAt))
      .filter(Number.isFinite);
    admitted = await ledger.admitInstalledRun({
      gate6Id: artifacts.envelope.gate6Id,
      gate6Nonce: artifacts.envelope.gate6Nonce,
      envelopeSha256: sha256(canonicalGate6Json(artifacts.envelope)),
      envelopeCoreSha256: artifacts.envelope.envelopeCoreSha256,
      releaseEnvironment: artifacts.envelope.releaseEnvironment,
      runtimeEnvironment: artifacts.envelope.runtimeEnvironment,
      drillMode: artifacts.envelope.drillMode,
      composeProject: artifacts.envelope.composeProject,
      candidateSha: artifacts.envelope.candidateSha,
      candidateImageDigest: artifacts.envelope.candidateImageDigest,
      rollbackSha: artifacts.envelope.rollbackSha,
      rollbackImageDigest: artifacts.envelope.rollbackImageDigest,
      productionTargetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
      operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
      protectedInstallEvidenceSha256: artifacts.envelope.protectedInstallEvidenceSha256,
      installedMigrationSetSha256: artifacts.envelope.installedMigrationSetSha256,
      installedSchemaVersion: artifacts.envelope.installedSchemaVersion,
      expiresAt: artifacts.envelope.expiresAt,
      monitorLeaseExpiresAt: new Date(now.getTime() + INITIAL_LEASE_MS).toISOString(),
      supervisorLeaseExpiresAt: new Date(now.getTime() + INITIAL_LEASE_MS).toISOString(),
      emergencySupervisorLeaseExpiresAt: new Date(Math.max(...recoveryExpiries)).toISOString(),
      installOperationId: operationId,
      transferTokenSha256: binding.transferTokenSha256,
      admitActionId: artifacts.action.actionId,
      actions: buildGate6AdmissionActions(artifacts.envelope),
      now,
    });
    slot = await ledger.getProductionSlotForHandoff();
  } else {
    if (
      slot.owner_type !== "gate6" ||
      slot.owner_id !== artifacts.envelope.gate6Id ||
      slot.operation_id !== operationId ||
      slot.transfer_token_sha256 !== null ||
      slot.state !== "active" ||
      Number(slot.version) !== binding.slotVersion + 1
    )
      throw new Error("Gate 6 admission reconciliation slot is invalid");
    admitted = { status: "admitted", slotVersion: Number(slot.version) };
  }
  if (input.runtimeContextAdapters) {
    await input.runtimeContextAdapters.write({
      schemaVersion: 1,
      gate6Id: artifacts.envelope.gate6Id,
      candidateSha: artifacts.envelope.candidateSha,
      candidateImageDigest: artifacts.envelope.candidateImageDigest,
      rollbackSha: artifacts.envelope.rollbackSha,
      targetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
      operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
      monitorThresholdsSha256: artifacts.envelope.monitorThresholdsSha256,
      composeProject: artifacts.envelope.composeProject,
      envelopeSha256: sha256(canonicalGate6Json(artifacts.envelope)),
      createdAt: artifacts.envelope.issuedAt,
    });
  }
  if (input.supervisionAdapters)
    await input.supervisionAdapters.start({ artifacts, admitted, ledger, now });
  const reconciled = await host.reconcile({
    operationId,
    releaseHash: lock.releaseHash,
    targetHash: lock.targetHash,
    leaseOwner: lock.lease.owner,
    observedSlot: slot,
    gate6LeaseOwner: HOST_GATE6_LEASE_OWNER,
    gate6LeaseDurationMs: HOST_GATE6_LEASE_MS,
    nowMs: now.getTime(),
  });
  return {
    status: "admitted",
    slotVersion: admitted.slotVersion,
    handoff: reconciled.outcome,
  };
}

function spawnChecker(executable, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? CHECKER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || bytes > 256 * 1024) {
        rejectPromise(new Error("Gate 6 semantic checker failed"));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function runPinnedGate6SemanticChecker(actionName, options = {}) {
  const spec = SEMANTIC_ACTIONS[actionName];
  if (!spec) throw new Error("unknown Gate 6 semantic checker action");
  const scriptPath = resolve(options.projectRoot ?? process.cwd(), spec.script);
  const scriptBytes = await readEvidenceBytes(scriptPath, { maxFileBytes: 512 * 1024 });
  const stdout = await (options.spawnChecker ?? spawnChecker)(
    process.execPath,
    [scriptPath, ...spec.arguments],
    { cwd: options.projectRoot ?? process.cwd(), timeoutMs: CHECKER_TIMEOUT_MS },
  );
  const text = stdout.trim();
  const output = JSON.parse(text);
  if (canonicalGate6Json(output) !== text || output?.ok !== true) {
    throw new Error("Gate 6 semantic checker output is invalid");
  }
  return Object.freeze({
    checkerName: spec.checkerName,
    checkerExecutableSha256: sha256(scriptBytes),
    checkerArgumentsSha256: sha256(canonicalGate6Json(spec.arguments)),
    outputSha256: sha256(text),
    output,
  });
}

export async function executeGate6SemanticAcceptance(input) {
  const spec = SEMANTIC_ACTIONS[input.actionName];
  if (!spec || input.artifacts.action?.scope !== spec.scope) {
    throw new Error("Gate 6 semantic action scope is invalid");
  }
  let checked;
  try {
    checked = await (input.runChecker ?? runPinnedGate6SemanticChecker)(input.actionName);
  } catch (error) {
    if (typeof input.ledger.revokeRun === "function") {
      await input.ledger.revokeRun({
        gate6Id: input.artifacts.envelope.gate6Id,
        reasonCode: "semantic-checker-failed",
        now: input.now,
      });
    }
    throw error;
  }
  if (
    checked.output?.ok !== true ||
    ![checked.checkerExecutableSha256, checked.checkerArgumentsSha256, checked.outputSha256].every(
      (value) => SHA256.test(value ?? ""),
    )
  )
    throw new Error("Gate 6 semantic checker receipt is invalid");
  const binding = await input.ledger.getActionBinding(
    input.artifacts.envelope.gate6Id,
    input.artifacts.action.scope,
    input.artifacts.action.actionId,
  );
  if (binding.expectedStage !== spec.expectedStage)
    throw new Error("Gate 6 semantic action stage graph mismatch");
  const now = input.now ?? new Date();
  let semanticReceipt;
  let durableSemanticReceipt;
  try {
    const existing = await (input.readSemanticReceipt ?? readGate6SemanticReceipt)(spec.scope, {
      allowMissing: true,
    });
    semanticReceipt = buildGate6SemanticReceipt({
      gate6Id: input.artifacts.envelope.gate6Id,
      scope: input.artifacts.action.scope,
      actionId: input.artifacts.action.actionId,
      expectedStage: binding.expectedStage,
      nextStage: spec.nextStage,
      checkerName: checked.checkerName,
      checkerExecutableSha256: checked.checkerExecutableSha256,
      checkerArgumentsSha256: checked.checkerArgumentsSha256,
      checkerOutputSha256: checked.outputSha256,
      checkerOutput: checked.output,
      checkedAt: existing?.receipt?.checkedAt ?? now.toISOString(),
    });
    if (
      existing !== null &&
      canonicalGate6Json(existing.receipt) !== canonicalGate6Json(semanticReceipt)
    ) {
      throw new Error("Gate 6 durable semantic receipt conflicts with checker output");
    }
    durableSemanticReceipt = await (input.writeSemanticReceipt ?? writeGate6SemanticReceipt)(
      semanticReceipt,
    );
  } catch (error) {
    if (typeof input.ledger.revokeRun === "function") {
      await input.ledger.revokeRun({
        gate6Id: input.artifacts.envelope.gate6Id,
        reasonCode: "semantic-receipt-conflict",
        now,
      });
    }
    throw error;
  }
  if (!SHA256.test(durableSemanticReceipt?.sha256 ?? "")) {
    throw new Error("Gate 6 durable semantic receipt hash is invalid");
  }
  const receipt = await input.ledger.beginAction({
    gate6Id: input.artifacts.envelope.gate6Id,
    scope: input.artifacts.action.scope,
    actionId: input.artifacts.action.actionId,
    approvalSha256: input.artifacts.approvalSha256,
    allowedMutationSha256: input.artifacts.action.allowedMutationSha256,
    envelopeSha256: sha256(canonicalGate6Json(input.artifacts.envelope)),
    envelopeCoreSha256: input.artifacts.envelope.envelopeCoreSha256,
    expectedStage: binding.expectedStage,
    expectedCheckerSha256: binding.expectedCheckerSha256,
    minimumCompensationValidityMs: (input.artifacts.envelope.rtoMinutes + 30) * 60_000,
    now,
  });
  await input.ledger.acceptSemanticChecker(receipt, {
    checkerName: checked.checkerName,
    acceptedCheckerSha256: semanticReceipt.acceptedCheckerSha256,
    nextStage: spec.nextStage,
    now: new Date(),
  });
  return {
    status: "accepted",
    nextStage: spec.nextStage,
    checkerSha256: semanticReceipt.acceptedCheckerSha256,
    receiptSha256: durableSemanticReceipt.sha256,
  };
}

function normalizedSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Gate 6 terminal snapshot is missing");
  }
  return snapshot;
}

export async function executeGate6Seal({ artifacts, ledger, now = new Date() }) {
  if (artifacts.action?.scope !== "gate6-seal-close")
    throw new Error("Gate 6 seal approval scope is invalid");
  const binding = await ledger.getActionBinding(
    artifacts.envelope.gate6Id,
    artifacts.action.scope,
    artifacts.action.actionId,
  );
  if (
    binding.expectedStage !== "pre-close-accepted" ||
    !SHA256.test(binding.expectedCheckerSha256 ?? "")
  ) {
    throw new Error("Gate 6 seal stage binding is invalid");
  }
  const snapshot = normalizedSnapshot(
    await ledger.getSanitizedSnapshot(artifacts.envelope.gate6Id),
  );
  const terminalEvidenceSha256 = sha256(canonicalGate6Json(snapshot));
  await ledger.sealForVerification({
    gate6Id: artifacts.envelope.gate6Id,
    scope: "gate6-seal-close",
    actionId: artifacts.action.actionId,
    approvalSha256: artifacts.approvalSha256,
    allowedMutationSha256: artifacts.action.allowedMutationSha256,
    expectedStage: "pre-close-accepted",
    expectedCheckerSha256: binding.expectedCheckerSha256,
    terminalEvidenceSha256,
    now,
  });
  return { status: "sealed-verifying", terminalEvidenceSha256 };
}

export async function executeGate6PostProofRegistration({
  artifacts,
  bundle,
  ledger,
  now = new Date(),
}) {
  const verified = verifyGate6PostProofBundle({
    bundle,
    envelope: artifacts.envelope,
    keyring: artifacts.keyring,
    now,
  });
  if (!verified.ok) throw new Error("Gate 6 post-proof bundle verification failed");
  const result = await ledger.registerPostProofActions({
    gate6Id: artifacts.envelope.gate6Id,
    expectedStage: "pre-close-accepted",
    expectedCheckerSha256: verified.acceptedCheckerSha256,
    revoke: verified.revoke,
    restore: verified.restore,
    now,
  });
  return Object.freeze({
    status: result.status,
    revokeActionId: verified.revoke.actionId,
    restoreActionId: verified.restore.actionId,
    priorGrantsSha256: verified.priorGrantsSha256,
  });
}

async function loadGate6PostProofBundle(path) {
  const bytes = await readEvidenceBytes(path, { maxFileBytes: 512 * 1024 });
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (text !== canonicalGate6Json(value))
    throw new Error("Gate 6 post-proof bundle must use canonical JSON");
  return value;
}

async function loadFinalVerifier(path) {
  const bytes = await readEvidenceBytes(path, { maxFileBytes: 512 * 1024 });
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (text !== canonicalGate6Json(value))
    throw new Error("Gate 6 final verifier must use canonical JSON");
  return { value, sha256: sha256(bytes) };
}

export async function executeGate6Release({
  artifacts,
  ledger,
  finalVerifierPath,
  now = new Date(),
  readVerifier,
}) {
  if (artifacts.action?.scope !== "gate6-release")
    throw new Error("Gate 6 release approval scope is invalid");
  const verifier = await (readVerifier ?? loadFinalVerifier)(finalVerifierPath);
  if (
    verifier.value?.ok !== true ||
    verifier.value?.evidence?.phase !== "final" ||
    verifier.value?.evidence?.gate6Id !== artifacts.envelope.gate6Id ||
    verifier.value?.evidence?.runStatus !== "sealed-verifying" ||
    verifier.value?.evidence?.slotState !== "sealed-verifying" ||
    !SHA256.test(verifier.value?.evidenceSha256 ?? "") ||
    verifier.value.evidenceSha256 !== sha256(canonicalGate6Json(verifier.value.evidence)) ||
    !SHA256.test(verifier.sha256 ?? "")
  )
    throw new Error("Gate 6 final verifier binding is invalid");
  const snapshot = normalizedSnapshot(
    await ledger.getSanitizedSnapshot(artifacts.envelope.gate6Id),
  );
  const terminalEvidenceSha256 =
    snapshot.terminal_evidence_sha256 ?? snapshot.terminalEvidenceSha256;
  if (!SHA256.test(terminalEvidenceSha256 ?? ""))
    throw new Error("Gate 6 terminal evidence binding is invalid");
  const restore = await ledger.getPostProofRestoreAction(artifacts.envelope.gate6Id);
  return ledger.releaseRun({
    gate6Id: artifacts.envelope.gate6Id,
    scope: "gate6-release",
    actionId: artifacts.action.actionId,
    approvalSha256: artifacts.approvalSha256,
    allowedMutationSha256: artifacts.action.allowedMutationSha256,
    terminalEvidenceSha256,
    verifierSha256: verifier.sha256,
    restoreActionId: restore.actionId,
    now,
  });
}

function expectedScopes(action) {
  if (action === "admit-and-supervise") return ["gate6-admit"];
  if (SEMANTIC_ACTIONS[action]) return [SEMANTIC_ACTIONS[action].scope];
  if (action === "seal-close") return ["gate6-seal-close"];
  if (action === "abort") return ["gate6-abort"];
  if (action === "release") return ["gate6-release"];
  return [];
}

export async function executeGate6Abort(input) {
  if (
    input.artifacts?.action?.scope !== "gate6-abort" ||
    input.artifacts.action.kind !== "emergency" ||
    input.artifacts?.envelope?.gate6Id !== input.artifacts.action.gate6Id
  )
    throw new Error("Gate 6 emergency abort binding is invalid");
  return input.ledger.emergencyAbort({
    gate6Id: input.artifacts.envelope.gate6Id,
    scope: "gate6-abort",
    actionId: input.artifacts.action.actionId,
    approvalSha256: input.artifacts.approvalSha256,
    allowedMutationSha256: input.artifacts.action.allowedMutationSha256,
    envelopeSha256: sha256(canonicalGate6Json(input.artifacts.envelope)),
    envelopeCoreSha256: input.artifacts.envelope.envelopeCoreSha256,
    reasonCode: "operator-abort",
    now: input.now ?? new Date(),
  });
}

async function startProductionSupervision(input) {
  const context = {
    schemaVersion: 1,
    gate6Id: input.artifacts.envelope.gate6Id,
    candidateSha: input.artifacts.envelope.candidateSha,
    candidateImageDigest: input.artifacts.envelope.candidateImageDigest,
    rollbackSha: input.artifacts.envelope.rollbackSha,
    targetDescriptorSha256: input.artifacts.envelope.productionTargetDescriptorSha256,
    operatorBundleSha256: input.artifacts.envelope.operatorBundleSha256,
    monitorThresholdsSha256: input.artifacts.envelope.monitorThresholdsSha256,
    composeProject: input.artifacts.envelope.composeProject,
    envelopeSha256: sha256(canonicalGate6Json(input.artifacts.envelope)),
    createdAt: input.artifacts.envelope.issuedAt,
  };
  await verifyGate6SupervisorInstall({ instance: context.candidateSha, context });
  const unit = gate6InstanceUnit("watchdog", context.candidateSha, context);
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/systemctl", ["restart", unit], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null)
    throw new Error("Gate 6 supervisor failed to start");
  const initialLeaseExpiry = input.now.getTime() + INITIAL_LEASE_MS;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await input.ledger.getSupervisorState(input.artifacts.envelope.gate6Id);
    if (
      state.status === "active" &&
      state.monitorStatus === "green" &&
      state.supervisorStatus === "green" &&
      Date.parse(state.monitorLeaseExpiresAt) > initialLeaseExpiry &&
      Date.parse(state.supervisorLeaseExpiresAt) > initialLeaseExpiry
    )
      return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("Gate 6 supervision did not establish fresh dual leases");
}

async function main() {
  try {
    const args = parseGate6RuntimeControlArgs(process.argv.slice(2));
    let result;
    if (args.action === "status") {
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: async ({ artifacts, ledger }) => ({
          status: "observed",
          snapshot: normalizedSnapshot(
            await ledger.getSanitizedSnapshot(artifacts.envelope.gate6Id),
          ),
        }),
      });
    } else if (args.action === "register-postproof") {
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: async ({ artifacts, ledger }) =>
          executeGate6PostProofRegistration({
            artifacts,
            ledger,
            bundle: await loadGate6PostProofBundle(args["postproof-bundle"]),
          }),
      });
    } else if (args.action === "abort") {
      result = await runVerifiedGate6AtomicController({
        args,
        expectedScopes: ["gate6-abort"],
        execute: ({ artifacts, ledger, now }) =>
          executeGate6Abort({
            artifacts,
            ledger,
            now,
          }),
      });
    } else {
      result = await runVerifiedGate6AtomicController({
        args,
        expectedScopes: expectedScopes(args.action),
        execute: async ({ artifacts, ledger }) => {
          if (args.action === "admit-and-supervise") {
            return executeGate6Admission({
              artifacts,
              ledger,
              operationId: args["operation-id"],
              runtimeContextAdapters: { write: writeGate6RuntimeContext },
              supervisionAdapters: { start: startProductionSupervision },
            });
          }
          if (SEMANTIC_ACTIONS[args.action]) {
            const release = await verifyGate6CandidateRelease({
              candidateSha: artifacts.envelope.candidateSha,
              operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
            });
            return executeGate6SemanticAcceptance({
              actionName: args.action,
              artifacts,
              ledger,
              runChecker: (actionName) =>
                runPinnedGate6SemanticChecker(actionName, {
                  projectRoot: release.candidateOperatorRoot,
                }),
            });
          }
          if (args.action === "seal-close") return executeGate6Seal({ artifacts, ledger });
          return executeGate6Release({
            artifacts,
            ledger,
            finalVerifierPath: args["final-verifier"],
          });
        },
      });
    }
    process.stdout.write(`${canonicalGate6Json({ ok: true, ...result })}\n`);
  } catch {
    process.stdout.write(
      `${canonicalGate6Json({ ok: false, code: "gate6-runtime-control-refused" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
