#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPENSATION_SCOPES,
  MANDATORY_FORWARD_SCOPES,
  canonicalGate6Json,
} from "../src/services/gate6-approval-runtime.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRE_CLOSE_FORWARD_SCOPES = MANDATORY_FORWARD_SCOPES.filter(
  (scope) => !["gate6-seal-close", "gate6-release"].includes(scope),
);
const RECEIPT_GRAPH = Object.freeze({
  dbTransition: Object.freeze({
    scope: "stage-accept-db-transition",
    expectedStage: "admitted",
    nextStage: "db-transition-stable",
  }),
  task9: Object.freeze({
    scope: "stage-accept-task9",
    expectedStage: "db-transition-stable",
    nextStage: "task9-accepted",
  }),
  worker: Object.freeze({
    scope: "stage-accept-worker",
    expectedStage: "task9-accepted",
    nextStage: "worker-accepted",
  }),
  phase3: Object.freeze({
    scope: "stage-accept-phase3",
    expectedStage: "worker-accepted",
    nextStage: "phase3-accepted",
  }),
  phase4: Object.freeze({
    scope: "stage-accept-phase4",
    expectedStage: "phase3-accepted",
    nextStage: "phase4-accepted",
  }),
  preClose: Object.freeze({
    scope: "stage-accept-pre-close",
    expectedStage: "final-baseline-stable",
    nextStage: "pre-close-accepted",
  }),
});
const REQUIRED_FINAL_RECEIPTS = Object.freeze(["task9", "worker", "phase3", "phase4", "preClose"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalGate6Json(value)).digest("hex");
}

function unwrapReceipt(value, name) {
  if (!isPlainObject(value)) throw new Error(`production child receipt is missing: ${name}`);
  const receipt = isPlainObject(value.receipt) ? value.receipt : value;
  if (!isPlainObject(receipt)) throw new Error(`production child receipt is invalid: ${name}`);
  if (value.receipt !== undefined && value.sha256 !== undefined) {
    if (!SHA256.test(value.sha256) || value.sha256 !== sha256Canonical(receipt)) {
      throw new Error(`production child receipt durable hash mismatch: ${name}`);
    }
  }
  return receipt;
}

function validateReceipt(name, value, gate6Id) {
  const descriptor = RECEIPT_GRAPH[name];
  const receipt = unwrapReceipt(value, name);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.gate6Id !== gate6Id ||
    receipt.scope !== descriptor.scope ||
    receipt.expectedStage !== descriptor.expectedStage ||
    receipt.nextStage !== descriptor.nextStage ||
    typeof receipt.actionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.actionId) ||
    !SHA256.test(receipt.checkerExecutableSha256 ?? "") ||
    !SHA256.test(receipt.checkerArgumentsSha256 ?? "") ||
    !SHA256.test(receipt.checkerOutputSha256 ?? "") ||
    !SHA256.test(receipt.acceptedCheckerSha256 ?? "") ||
    receipt.checkerOutputSha256 !== sha256Canonical(receipt.checkerOutput) ||
    receipt.checkerOutput?.ok !== true
  ) {
    throw new Error(`production child receipt binding is invalid: ${name}`);
  }
  const acceptedCore = {
    schemaVersion: 1,
    gate6Id: receipt.gate6Id,
    scope: receipt.scope,
    actionId: receipt.actionId,
    expectedStage: receipt.expectedStage,
    nextStage: receipt.nextStage,
    checkerName: receipt.checkerName,
    checkerExecutableSha256: receipt.checkerExecutableSha256,
    checkerArgumentsSha256: receipt.checkerArgumentsSha256,
    checkerOutputSha256: receipt.checkerOutputSha256,
  };
  if (receipt.acceptedCheckerSha256 !== sha256Canonical(acceptedCore)) {
    throw new Error(`production child receipt accepted-checker hash mismatch: ${name}`);
  }
  return receipt;
}

function oneReceiptAction(snapshot, receipt) {
  const matches = snapshot.actions.filter(
    (action) => action.scope === receipt.scope && action.actionId === receipt.actionId,
  );
  if (
    matches.length !== 1 ||
    matches[0].kind !== "forward" ||
    matches[0].status !== "succeeded" ||
    matches[0].afterEvidenceSha256 !== receipt.acceptedCheckerSha256
  ) {
    throw new Error(`production receipt ledger evidence hash mismatch: ${receipt.scope}`);
  }
  return matches[0];
}

export function buildProductionCanaryEvidenceFromReceipts(snapshot, receipts) {
  if (
    !isPlainObject(snapshot) ||
    !isPlainObject(snapshot.run) ||
    !isPlainObject(snapshot.slot) ||
    !Array.isArray(snapshot.actions) ||
    !isPlainObject(receipts)
  ) {
    throw new Error("production final-verifier snapshot or receipts are invalid");
  }
  const receiptNames = Object.keys(receipts);
  if (
    receiptNames.some((name) => !(name in RECEIPT_GRAPH)) ||
    REQUIRED_FINAL_RECEIPTS.some((name) => !receiptNames.includes(name))
  ) {
    throw new Error("production final-verifier receipt set is incomplete or unexpected");
  }
  const run = snapshot.run;
  const slot = snapshot.slot;
  if (
    typeof run.gate6Id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(run.gate6Id) ||
    run.status !== "sealed-verifying" ||
    run.currentStage !== "sealed-verifying" ||
    slot.ownerType !== "gate6" ||
    slot.ownerId !== run.gate6Id ||
    slot.state !== "sealed-verifying" ||
    slot.releaseSha !== run.candidateSha ||
    slot.targetDescriptorSha256 !== run.productionTargetDescriptorSha256 ||
    slot.operatorBundleSha256 !== run.operatorBundleSha256
  ) {
    throw new Error("production Gate 6 final-verifier run and slot binding is invalid");
  }
  const validated = Object.fromEntries(
    receiptNames.map((name) => [name, validateReceipt(name, receipts[name], run.gate6Id)]),
  );
  for (const receipt of Object.values(validated)) oneReceiptAction(snapshot, receipt);

  const terminal = run.terminalEvidenceSha256;
  const seal = snapshot.actions.filter((action) => action.scope === "gate6-seal-close");
  if (
    !SHA256.test(terminal ?? "") ||
    run.acceptedCheckerName !== "gate6-seal-close" ||
    run.acceptedCheckerSha256 !== terminal ||
    seal.length !== 1 ||
    seal[0].kind !== "forward" ||
    seal[0].status !== "succeeded" ||
    seal[0].afterEvidenceSha256 !== terminal
  ) {
    throw new Error("production Gate 6 terminal evidence binding is invalid");
  }

  const preClose = validated.preClose.checkerOutput;
  if (
    !isPlainObject(preClose.evidence) ||
    preClose.evidence.phase !== "pre-close" ||
    preClose.evidence.gate6Id !== run.gate6Id ||
    preClose.evidence.candidateSha !== run.candidateSha ||
    preClose.evidence.candidateImageDigest !== run.candidateImageDigest ||
    preClose.evidenceSha256 !== sha256Canonical(preClose.evidence) ||
    !isPlainObject(preClose.evidence.childBundleSha256)
  ) {
    throw new Error("production pre-close receipt output binding is invalid");
  }
  const childEvidence = Object.fromEntries(
    ["task9", "worker", "phase3", "phase4"].map((name) => {
      const bundleSha256 = preClose.evidence.childBundleSha256[name];
      if (!SHA256.test(bundleSha256 ?? "")) {
        throw new Error(`production pre-close child bundle is invalid: ${name}`);
      }
      return [
        name,
        {
          mode: "supervised-production",
          bundleSha256,
          releaseSha: run.candidateSha,
        },
      ];
    }),
  );
  const monitorGreen = run.monitorStatus === "green";
  const supervisorGreen = run.supervisorStatus === "green";
  const activePermitCount = Number(snapshot.activePermitCount);
  if (!Number.isSafeInteger(activePermitCount) || activePermitCount < 0) {
    throw new Error("production final-verifier permit count is invalid");
  }
  const uncompensatedWork = slot.uncompensatedWork === true || slot.uncompensatedWork === 1;
  const faultEndpointsEnabled =
    snapshot.faultEndpointsEnabled ??
    preClose.evidence.faultEndpointsEnabled ??
    activePermitCount !== 0;
  const controlProcessesHealthy =
    snapshot.controlProcessesHealthy ??
    preClose.evidence.controlProcessesHealthy ??
    (monitorGreen && supervisorGreen);
  return {
    releaseEnvironment: run.releaseEnvironment,
    runtimeEnvironment: run.runtimeEnvironment,
    drillMode: run.drillMode,
    composeProject: run.composeProject,
    candidateSha: run.candidateSha,
    candidateImageDigest: run.candidateImageDigest,
    childEvidence,
    actions: snapshot.actions.map((action) => ({
      scope: action.scope,
      actionId: action.actionId,
      kind: action.kind,
      status: action.status,
    })),
    monitor: {
      continuous: monitorGreen,
      supervisorContinuous: supervisorGreen,
      redSamples: monitorGreen && supervisorGreen ? 0 : 1,
    },
    activePermitCount,
    uncompensatedWork,
    runtimeIdentity: {
      releaseSha: run.candidateSha,
      imageDigest: run.candidateImageDigest,
      mixedRelease: false,
    },
    run: {
      gate6Id: run.gate6Id,
      status: run.status,
      currentStage: run.currentStage,
      terminalEvidenceSha256: run.terminalEvidenceSha256,
    },
    slot: {
      ownerType: slot.ownerType,
      ownerId: slot.ownerId,
      state: slot.state,
    },
    faultEndpointsEnabled,
    controlProcessesHealthy,
  };
}

function actionRows(evidence, scope) {
  return evidence.actions.filter((action) => action.scope === scope);
}

function verifyCommon(evidence) {
  if (
    evidence?.releaseEnvironment !== "production" ||
    evidence?.runtimeEnvironment !== "production" ||
    evidence?.drillMode !== "supervised-production" ||
    evidence?.composeProject !== "spx-production"
  )
    throw new Error("production discriminator quartet mismatch");
  if (!SHA.test(evidence.candidateSha ?? "") || !DIGEST.test(evidence.candidateImageDigest ?? "")) {
    throw new Error("production release identity is invalid");
  }
  const childNames = ["task9", "worker", "phase3", "phase4"];
  for (const name of childNames) {
    const child = evidence.childEvidence?.[name];
    if (
      child?.mode !== "supervised-production" ||
      child?.releaseSha !== evidence.candidateSha ||
      !SHA256.test(child?.bundleSha256 ?? "")
    )
      throw new Error(`production child evidence is invalid for ${name}`);
  }
  if (!Array.isArray(evidence.actions)) throw new Error("production action ledger is missing");
  const actionIds = new Set();
  for (const action of evidence.actions) {
    if (typeof action.actionId !== "string" || actionIds.has(action.actionId)) {
      throw new Error("production action ledger contains a duplicate action ID");
    }
    actionIds.add(action.actionId);
    if (action.status === "ambiguous")
      throw new Error("production action ledger contains ambiguous work");
  }
  for (const scope of PRE_CLOSE_FORWARD_SCOPES) {
    const rows = actionRows(evidence, scope);
    if (rows.length !== 1 || rows[0].kind !== "forward" || rows[0].status !== "succeeded") {
      throw new Error(`production forward action did not succeed exactly once: ${scope}`);
    }
  }
  for (const scope of COMPENSATION_SCOPES) {
    const rows = actionRows(evidence, scope);
    if (
      rows.length !== 1 ||
      rows[0].kind !== "compensation" ||
      !["registered", "succeeded", "not_needed"].includes(rows[0].status)
    )
      throw new Error(`production compensation action state is invalid: ${scope}`);
  }
  if (
    evidence.monitor?.continuous !== true ||
    evidence.monitor?.supervisorContinuous !== true ||
    evidence.monitor?.redSamples !== 0
  )
    throw new Error("production monitor continuity was not proven");
  if (evidence.activePermitCount !== 0) throw new Error("production fault permit remains active");
  if (evidence.uncompensatedWork !== false)
    throw new Error("production work remains uncompensated");
  if (
    evidence.runtimeIdentity?.releaseSha !== evidence.candidateSha ||
    evidence.runtimeIdentity?.imageDigest !== evidence.candidateImageDigest ||
    evidence.runtimeIdentity?.mixedRelease !== false
  )
    throw new Error("production runtime identity is mixed or stale");
  if (evidence.slot?.ownerType !== "gate6" || evidence.slot?.ownerId !== evidence.run?.gate6Id)
    throw new Error("production Gate 6 slot ownership mismatch");
}

export function verifyProductionCanaryEvidence(evidence, options) {
  if (!options || !["pre-close", "final"].includes(options.phase))
    throw new Error("production evidence phase is invalid");
  verifyCommon(evidence);
  if (options.phase === "pre-close") {
    if (
      evidence.run?.status !== "active" ||
      evidence.run?.currentStage !== "final-baseline-stable"
    ) {
      throw new Error("production pre-close run stage is invalid");
    }
    if (evidence.slot?.state !== "active") throw new Error("production pre-close slot is invalid");
  } else {
    const seal = actionRows(evidence, "gate6-seal-close");
    if (seal.length !== 1 || seal[0].status !== "succeeded")
      throw new Error("Gate 6 seal-close is not durable");
    const revoke = actionRows(evidence, "db-principal-revoke-legacy");
    const restore = actionRows(evidence, "db-principal-restore-legacy");
    const revokePath =
      revoke.length === 1 &&
      revoke[0].status === "succeeded" &&
      restore.length === 1 &&
      restore[0].status === "registered";
    const restorePath =
      restore.length === 1 && ["succeeded", "compensated"].includes(restore[0].status);
    if (!revokePath && !restorePath)
      throw new Error("legacy revoke/restore terminal path is invalid");
    if (
      evidence.run?.status !== "sealed-verifying" ||
      evidence.run?.currentStage !== "sealed-verifying" ||
      evidence.slot?.state !== "sealed-verifying"
    )
      throw new Error("production run and slot are not sealed-verifying");
    if (!SHA256.test(evidence.run?.terminalEvidenceSha256 ?? "")) {
      throw new Error("production terminal evidence hash is invalid");
    }
    if (evidence.faultEndpointsEnabled !== false || evidence.controlProcessesHealthy !== true) {
      throw new Error("production Gate 6 control plane is not healthy and disarmed");
    }
  }
  const output = {
    phase: options.phase,
    gate6Id: evidence.run.gate6Id,
    candidateSha: evidence.candidateSha,
    candidateImageDigest: evidence.candidateImageDigest,
    childBundleSha256: Object.fromEntries(
      Object.entries(evidence.childEvidence).map(([name, child]) => [name, child.bundleSha256]),
    ),
    runStatus: evidence.run.status,
    runStage: evidence.run.currentStage,
    slotState: evidence.slot.state,
    actionCount: evidence.actions.length,
    ...(options.phase === "final"
      ? { terminalEvidenceSha256: evidence.run.terminalEvidenceSha256 }
      : {}),
  };
  return {
    ok: true,
    evidenceSha256: createHash("sha256").update(canonicalGate6Json(output)).digest("hex"),
    evidence: output,
  };
}

async function main() {
  try {
    const values = Object.fromEntries(
      process.argv.slice(2).map((argument) => {
        const match = /^--(phase|evidence)=(.+)$/.exec(argument);
        if (!match) throw new Error("invalid arguments");
        return [match[1], match[2]];
      }),
    );
    if (!values.phase || !values.evidence || Object.keys(values).length !== 2)
      throw new Error("missing arguments");
    const text = await readFile(resolve(values.evidence), "utf8");
    const evidence = JSON.parse(text);
    if (text !== canonicalGate6Json(evidence)) throw new Error("evidence must be canonical");
    const result = verifyProductionCanaryEvidence(evidence, { phase: values.phase });
    process.stdout.write(`${canonicalGate6Json(result)}\n`);
  } catch {
    process.stdout.write('{"code":"production-canary-evidence-invalid","ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
