import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { COMPENSATION_SCOPES, MANDATORY_FORWARD_SCOPES } from "../src/services/gate6-approval.js";
import {
  buildProductionCanaryEvidenceFromReceipts,
  verifyProductionCanaryEvidence,
} from "../scripts/production-canary-evidence-check.mjs";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import { buildGate6SemanticReceipt } from "../scripts/lib/gate6-semantic-receipt.mjs";

const H = (character: string): string => character.repeat(64);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const preCloseScopes = MANDATORY_FORWARD_SCOPES.filter(
  (scope) => !["gate6-seal-close", "gate6-release"].includes(scope),
);
const actions = [
  ...preCloseScopes.map((scope, index) => ({
    scope,
    actionId: `forward-${index}`,
    kind: "forward",
    status: "succeeded",
  })),
  ...COMPENSATION_SCOPES.map((scope, index) => ({
    scope,
    actionId: `comp-${index}`,
    kind: "compensation",
    status: "registered",
  })),
];
const base = {
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  candidateSha: "a".repeat(40),
  candidateImageDigest: `sha256:${H("b")}`,
  childEvidence: {
    task9: { mode: "supervised-production", bundleSha256: H("1"), releaseSha: "a".repeat(40) },
    worker: { mode: "supervised-production", bundleSha256: H("2"), releaseSha: "a".repeat(40) },
    phase3: { mode: "supervised-production", bundleSha256: H("3"), releaseSha: "a".repeat(40) },
    phase4: { mode: "supervised-production", bundleSha256: H("4"), releaseSha: "a".repeat(40) },
  },
  actions,
  monitor: { continuous: true, redSamples: 0, supervisorContinuous: true },
  activePermitCount: 0,
  uncompensatedWork: false,
  runtimeIdentity: {
    releaseSha: "a".repeat(40),
    imageDigest: `sha256:${H("b")}`,
    mixedRelease: false,
  },
  run: { gate6Id: "gate6-prod-001", status: "active", currentStage: "final-baseline-stable" },
  slot: { ownerType: "gate6", ownerId: "gate6-prod-001", state: "active" },
  faultEndpointsEnabled: false,
  controlProcessesHealthy: true,
};

const preClose = verifyProductionCanaryEvidence(base, { phase: "pre-close" });
assert.equal(preClose.ok, true);
assert.match(preClose.evidenceSha256, /^[0-9a-f]{64}$/);
assert.throws(
  () =>
    verifyProductionCanaryEvidence({ ...base, composeProject: "default" }, { phase: "pre-close" }),
  /production discriminator/i,
);
assert.throws(
  () =>
    verifyProductionCanaryEvidence(
      {
        ...base,
        actions: [...actions, { ...actions[0], actionId: "replay" }],
      },
      { phase: "pre-close" },
    ),
  /exactly once|duplicate/i,
);

const final = verifyProductionCanaryEvidence(
  {
    ...base,
    actions: [
      ...actions,
      { scope: "gate6-seal-close", actionId: "seal", kind: "forward", status: "succeeded" },
      {
        scope: "db-principal-revoke-legacy",
        actionId: "revoke",
        kind: "forward",
        status: "succeeded",
      },
      {
        scope: "db-principal-restore-legacy",
        actionId: "restore",
        kind: "compensation",
        status: "registered",
      },
    ],
    run: {
      ...base.run,
      status: "sealed-verifying",
      currentStage: "sealed-verifying",
      terminalEvidenceSha256: H("f"),
    },
    slot: { ...base.slot, state: "sealed-verifying" },
  },
  { phase: "final" },
);
assert.equal(final.ok, true);
assert.equal(final.evidence.terminalEvidenceSha256, H("f"));
assert.throws(
  () =>
    verifyProductionCanaryEvidence(
      {
        ...base,
        actions: [
          ...actions,
          { scope: "gate6-seal-close", actionId: "seal", kind: "forward", status: "succeeded" },
        ],
        run: { ...base.run, status: "released" },
        slot: { ...base.slot, state: "released" },
      },
      { phase: "final" },
    ),
  /sealed|legacy revoke/i,
);

const gate6Id = "gate6-prod-001";
const receiptGraph = {
  dbTransition: ["stage-accept-db-transition", "admitted", "db-transition-stable"],
  task9: ["stage-accept-task9", "db-transition-stable", "task9-accepted"],
  worker: ["stage-accept-worker", "task9-accepted", "worker-accepted"],
  phase3: ["stage-accept-phase3", "worker-accepted", "phase3-accepted"],
  phase4: ["stage-accept-phase4", "phase3-accepted", "phase4-accepted"],
  preClose: ["stage-accept-pre-close", "final-baseline-stable", "pre-close-accepted"],
} as const;
const preCloseEvidence = {
  phase: "pre-close",
  gate6Id,
  candidateSha: base.candidateSha,
  candidateImageDigest: base.candidateImageDigest,
  childBundleSha256: {
    task9: H("1"),
    worker: H("2"),
    phase3: H("3"),
    phase4: H("4"),
  },
  runStatus: "active",
  runStage: "final-baseline-stable",
  slotState: "active",
  actionCount: actions.length,
  monitor: base.monitor,
  runtimeIdentity: base.runtimeIdentity,
  faultEndpointsEnabled: false,
  controlProcessesHealthy: true,
};
const receiptEntries = Object.fromEntries(
  Object.entries(receiptGraph).map(([name, [scope, expectedStage, nextStage]], index) => {
    const checkerOutput =
      name === "preClose"
        ? {
            ok: true,
            evidenceSha256: sha256(canonicalJson(preCloseEvidence)),
            evidence: preCloseEvidence,
          }
        : { ok: true, failures: [] };
    const receipt = buildGate6SemanticReceipt({
      gate6Id,
      scope,
      actionId: `accept-${index + 1}`,
      expectedStage,
      nextStage,
      checkerName: `${name}-production-evidence`,
      checkerExecutableSha256: H("a"),
      checkerArgumentsSha256: H("b"),
      checkerOutputSha256: sha256(canonicalJson(checkerOutput)),
      checkerOutput,
      checkedAt: "2026-07-16T00:59:00.000Z",
    });
    return [name, { receipt, sha256: sha256(canonicalJson(receipt)) }];
  }),
) as Record<
  keyof typeof receiptGraph,
  { receipt: ReturnType<typeof buildGate6SemanticReceipt>; sha256: string }
>;
const receiptActionByScope = new Map(
  Object.values(receiptEntries).map(({ receipt }) => [receipt.scope, receipt]),
);
const terminalEvidenceSha256 = H("f");
const sealedActions = [
  ...actions.map((action) => {
    const receipt = receiptActionByScope.get(action.scope);
    return receipt === undefined
      ? { ...action, afterEvidenceSha256: H("9") }
      : {
          ...action,
          actionId: receipt.actionId,
          afterEvidenceSha256: receipt.acceptedCheckerSha256,
        };
  }),
  {
    scope: "gate6-seal-close",
    actionId: "seal",
    kind: "forward",
    status: "succeeded",
    afterEvidenceSha256: terminalEvidenceSha256,
  },
  {
    scope: "db-principal-revoke-legacy",
    actionId: "revoke",
    kind: "forward",
    status: "succeeded",
    afterEvidenceSha256: H("7"),
  },
  {
    scope: "db-principal-restore-legacy",
    actionId: "restore",
    kind: "compensation",
    status: "registered",
    afterEvidenceSha256: null,
  },
];
const sealedSnapshot = {
  run: {
    gate6Id,
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    candidateSha: base.candidateSha,
    candidateImageDigest: base.candidateImageDigest,
    productionTargetDescriptorSha256: H("c"),
    operatorBundleSha256: H("d"),
    status: "sealed-verifying",
    currentStage: "sealed-verifying",
    stageVersion: 8,
    acceptedCheckerName: "gate6-seal-close",
    acceptedCheckerSha256: terminalEvidenceSha256,
    terminalEvidenceSha256,
    monitorStatus: "green",
    monitorLeaseExpiresAt: "2026-07-16T01:05:00.000Z",
    supervisorStatus: "green",
    supervisorLeaseExpiresAt: "2026-07-16T01:05:00.000Z",
    emergencySupervisorLeaseExpiresAt: "2026-07-16T02:00:00.000Z",
  },
  slot: {
    ownerType: "gate6",
    ownerId: gate6Id,
    state: "sealed-verifying",
    version: 9,
    uncompensatedWork: false,
    releaseSha: base.candidateSha,
    targetDescriptorSha256: H("c"),
    operatorBundleSha256: H("d"),
  },
  actions: sealedActions,
  activePermitCount: 0,
  faultEndpointsEnabled: false,
  controlProcessesHealthy: true,
};

const assembled = buildProductionCanaryEvidenceFromReceipts(sealedSnapshot, receiptEntries);
assert.equal(assembled.run.currentStage, "sealed-verifying");
assert.equal(assembled.run.terminalEvidenceSha256, terminalEvidenceSha256);
assert.deepEqual(assembled.childEvidence, base.childEvidence);
assert.equal(
  verifyProductionCanaryEvidence(assembled, { phase: "final" }).evidence.terminalEvidenceSha256,
  terminalEvidenceSha256,
);
assert.equal(verifyProductionCanaryEvidence(assembled, { phase: "final" }).ok, true);
assert.throws(
  () =>
    buildProductionCanaryEvidenceFromReceipts(
      {
        ...sealedSnapshot,
        actions: sealedActions.map((action) =>
          action.scope === "stage-accept-task9"
            ? { ...action, afterEvidenceSha256: H("0") }
            : action,
        ),
      },
      receiptEntries,
    ),
  /receipt|evidence hash|ledger/i,
);

console.log("production canary evidence check tests passed");
