import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FINAL_VERIFIER_PATH,
  exportFinalVerifier,
  parseFinalVerifierCliArgs,
} from "../scripts/gate6-final-verifier-export.mjs";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import {
  buildGate6SemanticReceipt,
  writeGate6SemanticReceipt,
} from "../scripts/lib/gate6-semantic-receipt.mjs";
import { COMPENSATION_SCOPES, MANDATORY_FORWARD_SCOPES } from "../src/services/gate6-approval.js";

process.env.NODE_ENV = "test";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const H = (value: string): string => sha256(value);
const CANDIDATE_SHA = "a".repeat(40);
const GATE6_ID = "gate6-prod-001";
const NOW = new Date("2026-07-16T01:00:00.000Z");
const LEASE = "2026-07-16T01:05:00.000Z";
const TERMINAL = H("terminal");

const RECEIPTS = Object.freeze({
  dbTransition: ["stage-accept-db-transition", "admitted", "db-transition-stable"],
  task9: ["stage-accept-task9", "db-transition-stable", "task9-accepted"],
  worker: ["stage-accept-worker", "task9-accepted", "worker-accepted"],
  phase3: ["stage-accept-phase3", "worker-accepted", "phase3-accepted"],
  phase4: ["stage-accept-phase4", "phase3-accepted", "phase4-accepted"],
  preClose: ["stage-accept-pre-close", "final-baseline-stable", "pre-close-accepted"],
} as const);

const childBundleSha256 = Object.freeze({
  task9: H("task9-bundle"),
  worker: H("worker-bundle"),
  phase3: H("phase3-bundle"),
  phase4: H("phase4-bundle"),
});

const producer = () => ({
  repository: "fastest4u/SPX",
  environment: "production",
  workflow: ".github/workflows/gate6-final-verifier-exporter.yml",
  workflowSha: "b".repeat(40),
  workflowFileSha256: H("final-verifier-workflow"),
});

function hostLock(revision = 12) {
  return {
    schemaVersion: 3,
    operationId: "install-001",
    operationType: "install",
    releaseHash: H("release"),
    targetHash: H("target"),
    state: "gate6-active",
    lease: {
      owner: "systemd:spx-gate6-supervisor",
      heartbeatAt: "2026-07-16T00:59:55.000Z",
      expiresAt: LEASE,
    },
    protectedInstall: {
      operationId: "install-001",
      transferTokenSha256: H("transfer"),
      protectedInstallEvidenceSha256: H("install-evidence"),
      releaseSha: CANDIDATE_SHA,
      targetDescriptorSha256: H("target"),
      operatorBundleSha256: H("operator"),
      installedMigrationSetSha256: H("migrations"),
      installedSchemaVersion: 36,
      slotVersion: 8,
    },
    handoff: {
      gate6Id: GATE6_ID,
      transferTokenSha256: H("transfer"),
      expectedSlotVersion: 8,
      slotVersion: 9,
      recordedAt: "2026-07-16T00:55:00.000Z",
    },
    revision,
    updatedAt: "2026-07-16T00:59:55.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spx-final-verifier-"));
  const receiptRoot = join(root, "receipts");
  const exportRoot = join(root, "evidence");
  await mkdir(receiptRoot, { mode: 0o700 });
  await mkdir(exportRoot, { mode: 0o700 });

  const preCloseEvidence = {
    phase: "pre-close",
    gate6Id: GATE6_ID,
    candidateSha: CANDIDATE_SHA,
    candidateImageDigest: `sha256:${H("image")}`,
    childBundleSha256,
    runStatus: "active",
    runStage: "final-baseline-stable",
    slotState: "active",
    actionCount: 1,
    monitor: { continuous: true, supervisorContinuous: true, redSamples: 0 },
    runtimeIdentity: {
      releaseSha: CANDIDATE_SHA,
      imageDigest: `sha256:${H("image")}`,
      mixedRelease: false,
    },
    faultEndpointsEnabled: false,
    controlProcessesHealthy: true,
  };
  const receipts: Record<string, ReturnType<typeof buildGate6SemanticReceipt>> = {};
  for (const [index, [name, [scope, expectedStage, nextStage]]] of Object.entries(
    RECEIPTS,
  ).entries()) {
    const checkerOutput =
      name === "preClose"
        ? {
            ok: true,
            evidenceSha256: sha256(canonicalJson(preCloseEvidence)),
            evidence: preCloseEvidence,
          }
        : { ok: true, failures: [] };
    const receipt = buildGate6SemanticReceipt({
      gate6Id: GATE6_ID,
      scope,
      actionId: `accept-${index + 1}`,
      expectedStage,
      nextStage,
      checkerName: `${name}-production-evidence`,
      checkerExecutableSha256: H(`${name}:executable`),
      checkerArgumentsSha256: H(`${name}:arguments`),
      checkerOutputSha256: sha256(canonicalJson(checkerOutput)),
      checkerOutput,
      checkedAt: "2026-07-16T00:59:00.000Z",
    });
    receipts[name] = receipt;
    await writeGate6SemanticReceipt(receipt, { root: receiptRoot });
  }

  const receiptByScope = new Map(
    Object.values(receipts).map((receipt) => [receipt.scope, receipt]),
  );
  const actions = [
    ...MANDATORY_FORWARD_SCOPES.filter((scope) => scope !== "gate6-release").map((scope, index) => {
      const receipt = receiptByScope.get(scope);
      return {
        scope,
        actionId: receipt?.actionId ?? `forward-${index + 1}`,
        kind: "forward",
        pairedActionId: null,
        requiredStage: receipt?.expectedStage ?? "admitted",
        requiredCheckerSha256: receipt?.checkerExecutableSha256 ?? null,
        status: "succeeded",
        afterEvidenceSha256:
          scope === "gate6-seal-close"
            ? TERMINAL
            : (receipt?.acceptedCheckerSha256 ?? H(`${scope}:after`)),
        completedAt: "2026-07-16T00:59:30.000Z",
      };
    }),
    ...COMPENSATION_SCOPES.map((scope, index) => ({
      scope,
      actionId: `compensation-${index + 1}`,
      kind: "compensation",
      pairedActionId: `forward-${index + 1}`,
      requiredStage: "revoked",
      requiredCheckerSha256: null,
      status: "registered",
      afterEvidenceSha256: null,
      completedAt: null,
    })),
    {
      scope: "db-principal-revoke-legacy",
      actionId: "revoke-legacy",
      kind: "forward",
      pairedActionId: null,
      requiredStage: "pre-close-accepted",
      requiredCheckerSha256: H("pre-close-checker"),
      status: "succeeded",
      afterEvidenceSha256: H("revoke-after"),
      completedAt: "2026-07-16T00:59:40.000Z",
    },
    {
      scope: "db-principal-restore-legacy",
      actionId: "restore-legacy",
      kind: "compensation",
      pairedActionId: "revoke-legacy",
      requiredStage: "revoked",
      requiredCheckerSha256: H("pre-close-checker"),
      status: "registered",
      afterEvidenceSha256: null,
      completedAt: null,
    },
  ];
  const snapshot = {
    run: {
      gate6Id: GATE6_ID,
      releaseEnvironment: "production",
      runtimeEnvironment: "production",
      drillMode: "supervised-production",
      composeProject: "spx-production",
      candidateSha: CANDIDATE_SHA,
      candidateImageDigest: `sha256:${H("image")}`,
      productionTargetDescriptorSha256: H("target"),
      operatorBundleSha256: H("operator"),
      status: "sealed-verifying",
      currentStage: "sealed-verifying",
      stageVersion: 8,
      acceptedCheckerName: "gate6-seal-close",
      acceptedCheckerSha256: TERMINAL,
      terminalEvidenceSha256: TERMINAL,
      monitorStatus: "green",
      monitorLeaseExpiresAt: LEASE,
      supervisorStatus: "green",
      supervisorLeaseExpiresAt: LEASE,
      emergencySupervisorLeaseExpiresAt: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T03:00:00.000Z",
    },
    slot: {
      ownerType: "gate6",
      ownerId: GATE6_ID,
      state: "sealed-verifying",
      version: 9,
      uncompensatedWork: false,
      releaseSha: CANDIDATE_SHA,
      targetDescriptorSha256: H("target"),
      operatorBundleSha256: H("operator"),
      heartbeatAt: "2026-07-16T00:59:55.000Z",
      expiresAt: "2026-07-16T03:00:00.000Z",
    },
    actions,
    activePermitCount: 0,
  };
  let snapshots = [structuredClone(snapshot), structuredClone(snapshot)];
  let locks = [hostLock(), hostLock(13)];
  const context = {
    gate6Id: GATE6_ID,
    ledger: {
      async getFinalVerifierSnapshot() {
        const value = snapshots.shift();
        if (value === undefined) throw new Error("missing snapshot");
        return structuredClone(value);
      },
    },
    now: NOW,
    producer: producer(),
    receiptRoot,
    exportRoot,
    async readHostLock() {
      const value = locks.shift();
      if (value === undefined) throw new Error("missing host lock");
      return structuredClone(value);
    },
  };
  return {
    root,
    receiptRoot,
    exportRoot,
    receipts,
    snapshot,
    context,
    setSnapshots(...values: Array<typeof snapshot>) {
      snapshots = values.map((value) => structuredClone(value));
    },
    setLocks(...values: Array<ReturnType<typeof hostLock>>) {
      locks = values.map((value) => structuredClone(value));
    },
    async cleanup() {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("exports an immutable final verifier from two compatible sealed reads", async () => {
  const f = await fixture();
  try {
    const verifier = await exportFinalVerifier(f.context);
    assert.equal(verifier.ok, true);
    assert.equal(verifier.evidence.phase, "final");
    assert.equal(verifier.evidence.runStatus, "sealed-verifying");
    assert.equal(verifier.evidence.slotState, "sealed-verifying");
    assert.equal(verifier.evidence.terminalEvidenceSha256, f.snapshot.run.terminalEvidenceSha256);
    assert.equal(verifier.evidenceSha256, sha256(canonicalJson(verifier.evidence)));
    assert.deepEqual(Object.keys(verifier.producer).sort(), [
      "environment",
      "repository",
      "workflow",
      "workflowFileSha256",
      "workflowSha",
    ]);
    const path = join(f.exportRoot, "final-verifier.json");
    assert.equal(await readFile(path, "utf8"), canonicalJson(verifier));
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o400);
    assert.deepEqual(await readdir(f.exportRoot), ["final-verifier.json"]);
  } finally {
    await f.cleanup();
  }
});

test("accepts the durable handoff fence after the sealed slot version advances", async () => {
  const f = await fixture();
  try {
    const advanced = structuredClone(f.snapshot);
    advanced.slot.version = f.snapshot.slot.version + 7;
    f.setSnapshots(advanced, advanced);
    const verifier = await exportFinalVerifier(f.context);
    assert.equal(verifier.ok, true);
    assert.equal(verifier.evidence.slotState, "sealed-verifying");
  } finally {
    await f.cleanup();
  }
});

test("rejects unsafe sealed-state, receipt, terminal, and lock changes", async (t) => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void]> = [
    [
      "active run",
      (f) => {
        const changed = structuredClone(f.snapshot);
        changed.run.status = "active";
        f.setSnapshots(changed, changed);
      },
    ],
    [
      "active permit",
      (f) => {
        const changed = structuredClone(f.snapshot);
        changed.activePermitCount = 1;
        f.setSnapshots(changed, changed);
      },
    ],
    [
      "ambiguous action",
      (f) => {
        const changed = structuredClone(f.snapshot);
        changed.actions[0].status = "ambiguous";
        f.setSnapshots(changed, changed);
      },
    ],
    [
      "terminal mismatch",
      (f) => {
        const changed = structuredClone(f.snapshot);
        changed.run.terminalEvidenceSha256 = H("changed-terminal");
        f.setSnapshots(changed, changed);
      },
    ],
    [
      "receipt ledger mismatch",
      (f) => {
        const changed = structuredClone(f.snapshot);
        const action = changed.actions.find((row) => row.scope === "stage-accept-task9")!;
        action.afterEvidenceSha256 = H("wrong-receipt");
        f.setSnapshots(changed, changed);
      },
    ],
    [
      "slot released during export",
      (f) => {
        const changed = structuredClone(f.snapshot);
        changed.slot.state = "released";
        f.setSnapshots(f.snapshot, changed);
      },
    ],
    [
      "host handoff changed",
      (f) => {
        const changed = hostLock(13);
        changed.handoff.gate6Id = "gate6-other-001";
        f.setLocks(hostLock(), changed);
      },
    ],
    [
      "missing child receipt",
      async (f) => {
        const path = join(f.receiptRoot, "stage-accept-worker.json");
        await chmod(path, 0o600).catch(() => undefined);
        await unlink(path);
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        await mutate(f);
        await assert.rejects(
          exportFinalVerifier(f.context),
          /Gate 6|receipt|sealed|permit|action|terminal|lock|missing|changed/i,
        );
      } finally {
        await f.cleanup();
      }
    });
  }
});

test("requires the exact final producer and create-once canonical artifact", async () => {
  const f = await fixture();
  try {
    f.context.producer.workflow = ".github/workflows/trusted-deploy.yml";
    await assert.rejects(exportFinalVerifier(f.context), /producer/i);
  } finally {
    await f.cleanup();
  }

  const conflict = await fixture();
  try {
    await writeFile(join(conflict.exportRoot, "final-verifier.json"), "{}", { mode: 0o400 });
    await assert.rejects(exportFinalVerifier(conflict.context), /conflict|canonical|durable/i);
  } finally {
    await conflict.cleanup();
  }
});

test("CLI is zero-argument and fixed-root only", async () => {
  assert.deepEqual(parseFinalVerifierCliArgs([]), {});
  assert.throws(() => parseFinalVerifierCliArgs(["--root=/tmp/candidate"]), /zero|argument/i);
  assert.equal(FINAL_VERIFIER_PATH, "/var/lib/spx-production-rollout/evidence/final-verifier.json");
  const source = await readFile(
    join(process.cwd(), "scripts", "gate6-final-verifier-export.mjs"),
    "utf8",
  );
  assert.match(source, /\/usr\/bin\/mysql/);
  assert.doesNotMatch(source, /from\s+["']mysql2|releaseRun\s*\(|completeRelease\s*\(/);
});
