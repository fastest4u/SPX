import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  acquireProductionMutationLock,
  commitProductionInstallHostLock,
  markProductionInstallBootstrapOwned,
  markProductionMutationTerminal,
  previewProductionInstallHostLockCommit,
  readProductionInstallHostLockCommit,
  readProductionMutationLock,
  reconcileProductionInstallAwaitingGate6,
  reconcileProductionMutationLock,
  verifyProductionMutationLock,
} from "../scripts/production-mutation-host-lock.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const START_MS = Date.parse("2026-07-10T04:00:00.000Z");
const INSTALL_SOURCE_SHA = "1".repeat(40);
const INSTALL_OPERATION_ID = "deploy-100-1-production";
const INSTALL_HEARTBEAT_AT = "2026-07-10T04:10:00.000Z";
const INSTALL_EXPIRES_AT = "2026-07-10T05:10:00.000Z";
const INSTALL_EVIDENCE_SHA256 = "e".repeat(64);

function request(operationId = "adopt-prod-001") {
  return {
    operationId,
    operationType: "adoption",
    releaseHash: HASH_A,
    targetHash: HASH_B,
    state: "adopting",
    rollbackJournalHash: HASH_C,
    rollbackIdentity: {
      project: "spx",
      releaseHash: HASH_A,
      imageDigest: IMAGE_DIGEST,
      serviceSetHash: HASH_B,
      configHash: HASH_C,
    },
    lease: {
      owner: "github:run-123",
      durationMs: 30_000,
    },
  } as const;
}

function installRequest() {
  return {
    ...request(INSTALL_OPERATION_ID),
    operationType: "install",
    state: "installing",
    lease: {
      owner: `workflow:${INSTALL_OPERATION_ID}`,
      durationMs: 60 * 60 * 1_000,
    },
  } as const;
}

const installBootstrapBinding = {
  operationId: INSTALL_OPERATION_ID,
  transferTokenSha256: "2".repeat(64),
  installIntentEvidenceSha256: "3".repeat(64),
  releaseSha: INSTALL_SOURCE_SHA,
  targetDescriptorSha256: HASH_B,
  operatorBundleSha256: "4".repeat(64),
  installedMigrationSetSha256: "5".repeat(64),
  installedSchemaVersion: 36,
  heartbeatAt: "2026-07-10T04:00:10.000Z",
  expiresAt: "2026-07-10T05:00:10.000Z",
  slotVersion: 1,
} as const;

const installCommitIdentity = {
  operationId: INSTALL_OPERATION_ID,
  releaseSha: INSTALL_SOURCE_SHA,
  targetDescriptorSha256: HASH_B,
  operatorBundleSha256: installBootstrapBinding.operatorBundleSha256,
} as const;

function installHostCommitBinding(overrides: Record<string, unknown> = {}) {
  return {
    ...installCommitIdentity,
    protectedInstallEvidenceSha256: INSTALL_EVIDENCE_SHA256,
    heartbeatAt: INSTALL_HEARTBEAT_AT,
    expiresAt: INSTALL_EXPIRES_AT,
    expectedCurrentVersion: 2,
    expectedNextVersion: 3,
    ...overrides,
  };
}

async function withStateDir(run: (stateDir: string) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), "spx-production-lock-test-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  const scriptSource = readFileSync("scripts/production-mutation-host-lock.mjs", "utf8");
  assert.match(scriptSource, /\/var\/lib\/spx-production-mutation/);
  assert.match(scriptSource, /fsync/);
  assert.doesNotMatch(scriptSource, /shell\s*:\s*true/);


  const serviceSource = readFileSync(
    "deploy/systemd/spx-production-mutation-reconciler.service",
    "utf8",
  );
  assert.match(serviceSource, /^User=root$/m);
  assert.match(serviceSource, /--action=reconcile/);
  assert.match(serviceSource, /--watch=true/);
  assert.match(serviceSource, /^Restart=always$/m);
  assert.match(serviceSource, /^ReadWritePaths=\/var\/lib\/spx-production-mutation$/m);
  assert.match(serviceSource, /^NoNewPrivileges=true$/m);

  await withStateDir(async (stateDir) => {
    const acquired = await acquireProductionMutationLock({
      stateDir,
      request: request(),
      nowMs: START_MS,
      allowNonRoot: true,
    });
    assert.equal(acquired.state, "adopting");
    assert.equal(acquired.revision, 1);
    assert.equal(acquired.lease.expiresAt, "2026-07-10T04:00:30.000Z");
    assert.deepEqual(acquired.rollbackIdentity, request().rollbackIdentity);

    const persisted = await readProductionMutationLock({ stateDir, allowNonRoot: true });
    assert.deepEqual(persisted, acquired);

    await assert.rejects(
      acquireProductionMutationLock({
        stateDir,
        request: request("other-operation"),
        nowMs: START_MS,
        allowNonRoot: true,
      }),
      /production-mutation-lock-held/,
    );

    await assert.rejects(
      verifyProductionMutationLock({
        stateDir,
        operationId: acquired.operationId,
        releaseHash: HASH_C,
        targetHash: HASH_B,
        nowMs: START_MS + 1_000,
        leaseOwner: "github:run-123",
        renewLeaseMs: 30_000,
        allowNonRoot: true,
      }),
      /production-mutation-lock-identity-mismatch/,
    );

    const verified = await verifyProductionMutationLock({
      stateDir,
      operationId: acquired.operationId,
      releaseHash: HASH_A,
      targetHash: HASH_B,
      nowMs: START_MS + 1_000,
      leaseOwner: "github:run-123",
      renewLeaseMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(verified.revision, 2);
    assert.equal(verified.lease.heartbeatAt, "2026-07-10T04:00:01.000Z");
  });

  await withStateDir(async (stateDir) => {
    await acquireProductionMutationLock({
      stateDir,
      request: installRequest(),
      nowMs: START_MS,
      allowNonRoot: true,
    });
    await markProductionInstallBootstrapOwned({
      stateDir,
      operationId: INSTALL_OPERATION_ID,
      releaseHash: HASH_A,
      targetHash: HASH_B,
      leaseOwner: `workflow:${INSTALL_OPERATION_ID}`,
      nowMs: START_MS + 10_000,
      allowNonRoot: true,
      binding: installBootstrapBinding,
    });

    const preview = await previewProductionInstallHostLockCommit({
      stateDir,
      allowNonRoot: true,
      identity: installCommitIdentity,
    });
    assert.deepEqual(preview, {
      current: { operationId: INSTALL_OPERATION_ID, state: "installing", version: 2 },
      next: { operationId: INSTALL_OPERATION_ID, state: "installed-awaiting-gate6", version: 3 },
    });
    assert.deepEqual(
      await readProductionInstallHostLockCommit({
        stateDir,
        allowNonRoot: true,
        binding: installHostCommitBinding(),
      }),
      {
        operationId: INSTALL_OPERATION_ID,
        state: "installing",
        version: 2,
        protectedInstallEvidenceSha256: installBootstrapBinding.installIntentEvidenceSha256,
        heartbeatAt: "2026-07-10T04:00:00.000Z",
        expiresAt: "2026-07-10T05:00:00.000Z",
        releaseSha: INSTALL_SOURCE_SHA,
        targetDescriptorSha256: HASH_B,
        operatorBundleSha256: installBootstrapBinding.operatorBundleSha256,
        installedMigrationSetSha256: installBootstrapBinding.installedMigrationSetSha256,
        installedSchemaVersion: installBootstrapBinding.installedSchemaVersion,
      },
    );

    const committed = await commitProductionInstallHostLock({
      stateDir,
      allowNonRoot: true,
      binding: installHostCommitBinding(),
    });
    assert.deepEqual(committed, {
      status: "installed-awaiting-gate6",
      hostLockVersion: 3,
      idempotent: false,
    });
    const durable = await readProductionInstallHostLockCommit({
      stateDir,
      allowNonRoot: true,
      binding: installHostCommitBinding(),
    });
    assert.deepEqual(durable, {
      operationId: INSTALL_OPERATION_ID,
      state: "installed-awaiting-gate6",
      version: 3,
      protectedInstallEvidenceSha256: INSTALL_EVIDENCE_SHA256,
      heartbeatAt: INSTALL_HEARTBEAT_AT,
      expiresAt: INSTALL_EXPIRES_AT,
      releaseSha: INSTALL_SOURCE_SHA,
      targetDescriptorSha256: HASH_B,
      operatorBundleSha256: installBootstrapBinding.operatorBundleSha256,
      installedMigrationSetSha256: installBootstrapBinding.installedMigrationSetSha256,
      installedSchemaVersion: installBootstrapBinding.installedSchemaVersion,
    });
    assert.deepEqual(
      await commitProductionInstallHostLock({
        stateDir,
        allowNonRoot: true,
        binding: installHostCommitBinding(),
      }),
      { status: "installed-awaiting-gate6", hostLockVersion: 3, idempotent: true },
    );
    await assert.rejects(
      reconcileProductionInstallAwaitingGate6({
        stateDir,
        allowNonRoot: true,
        observedSlot: {},
      }),
      /prepared-commit-required/,
    );
    const reconciledSamePrepared = await reconcileProductionInstallAwaitingGate6({
      stateDir,
      allowNonRoot: true,
      binding: installHostCommitBinding(),
    });
    assert.equal(reconciledSamePrepared.revision, 3);
    assert.equal(reconciledSamePrepared.lease.heartbeatAt, INSTALL_HEARTBEAT_AT);

    for (const changed of [
      { protectedInstallEvidenceSha256: "f".repeat(64) },
      { heartbeatAt: "2026-07-10T04:10:01.000Z" },
      { expiresAt: "2026-07-10T05:10:01.000Z" },
      { expectedCurrentVersion: 3, expectedNextVersion: 4 },
      { releaseSha: "2".repeat(40) },
      { targetDescriptorSha256: HASH_C },
      { operatorBundleSha256: "6".repeat(64) },
    ]) {
      await assert.rejects(
        commitProductionInstallHostLock({
          stateDir,
          allowNonRoot: true,
          binding: installHostCommitBinding(changed),
        }),
        /prepared-commit|binding|version|identity|conflict/,
      );
    }

    const expiredPrepared = await reconcileProductionMutationLock({
      stateDir,
      allowNonRoot: true,
      nowMs: Date.parse(INSTALL_EXPIRES_AT) + 1,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
    });
    assert.equal(expiredPrepared.outcome, "protected-install-prepared-commit-required");
    assert.equal(expiredPrepared.lock.revision, 3);
    assert.equal(expiredPrepared.lock.lease.heartbeatAt, INSTALL_HEARTBEAT_AT);
    assert.equal(expiredPrepared.lock.lease.expiresAt, INSTALL_EXPIRES_AT);
    assert.equal(existsSync(join(stateDir, "lock.json")), true);
  });

  await withStateDir(async (stateDir) => {
    await acquireProductionMutationLock({
      stateDir,
      request: installRequest(),
      nowMs: START_MS,
      allowNonRoot: true,
    });
    await markProductionInstallBootstrapOwned({
      stateDir,
      operationId: INSTALL_OPERATION_ID,
      releaseHash: HASH_A,
      targetHash: HASH_B,
      leaseOwner: `workflow:${INSTALL_OPERATION_ID}`,
      nowMs: START_MS + 10_000,
      allowNonRoot: true,
      binding: installBootstrapBinding,
    });
    await assert.rejects(
      commitProductionInstallHostLock({
        stateDir,
        allowNonRoot: true,
        binding: installHostCommitBinding({ expectedNextVersion: 4 }),
      }),
      /version/,
    );
    assert.equal(
      (await readProductionMutationLock({ stateDir, allowNonRoot: true })).state,
      "installing",
      "a rejected prepared commit must leave the host lock blocking",
    );
    const expiredPreparedOwner = await reconcileProductionMutationLock({
      stateDir,
      allowNonRoot: true,
      nowMs: Date.parse("2026-07-10T05:00:00.001Z"),
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
    });
    assert.equal(expiredPreparedOwner.outcome, "protected-install-prepared-commit-required");
    assert.equal(expiredPreparedOwner.lock.state, "installing");
    assert.equal(expiredPreparedOwner.lock.revision, 2);
  });

  await withStateDir(async (stateDir) => {
    await acquireProductionMutationLock({
      stateDir,
      request: installRequest(),
      nowMs: START_MS,
      allowNonRoot: true,
    });
    await markProductionInstallBootstrapOwned({
      stateDir,
      operationId: INSTALL_OPERATION_ID,
      releaseHash: HASH_A,
      targetHash: HASH_B,
      leaseOwner: `workflow:${INSTALL_OPERATION_ID}`,
      nowMs: START_MS + 20 * 60 * 1_000,
      allowNonRoot: true,
      binding: installBootstrapBinding,
    });
    await assert.rejects(
      commitProductionInstallHostLock({
        stateDir,
        allowNonRoot: true,
        binding: installHostCommitBinding(),
      }),
      /prepared-commit|binding|timestamp/i,
    );
    const unchanged = await readProductionMutationLock({ stateDir, allowNonRoot: true });
    assert.equal(unchanged.state, "installing");
    assert.equal(unchanged.revision, 2);
  });

  await withStateDir(async (stateDir) => {
    await acquireProductionMutationLock({
      stateDir,
      request: request(),
      nowMs: START_MS,
      allowNonRoot: true,
    });

    const recovery = await reconcileProductionMutationLock({
      stateDir,
      nowMs: START_MS + 31_000,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(recovery.outcome, "recovery-required");
    assert.equal(recovery.lock?.state, "recovering");
    assert.equal(existsSync(join(stateDir, "lock.json")), true);

    const held = await reconcileProductionMutationLock({
      stateDir,
      nowMs: START_MS + 32_000,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(held.outcome, "recovery-required");
    assert.equal(held.lock?.state, "recovering");

    await assert.rejects(
      markProductionMutationTerminal({
        stateDir,
        operationId: "wrong-operation",
        releaseHash: HASH_A,
        targetHash: HASH_B,
        nowMs: START_MS + 33_000,
        leaseOwner: "systemd:spx-production-mutation-reconciler",
        terminalPostcondition: {
          kind: "rollback-restored",
          hash: HASH_C,
        },
        allowNonRoot: true,
      }),
      /production-mutation-lock-identity-mismatch/,
    );

    await assert.rejects(
      markProductionMutationTerminal({
        stateDir,
        operationId: request().operationId,
        releaseHash: HASH_A,
        targetHash: HASH_B,
        nowMs: START_MS + 33_000,
        leaseOwner: "github:run-123",
        terminalPostcondition: {
          kind: "rollback-restored",
          hash: HASH_C,
        },
        allowNonRoot: true,
      }),
      /production-mutation-lock-lease-owner-mismatch/,
    );

    const terminal = await markProductionMutationTerminal({
      stateDir,
      operationId: request().operationId,
      releaseHash: HASH_A,
      targetHash: HASH_B,
      nowMs: START_MS + 33_000,
      leaseOwner: "systemd:spx-production-mutation-reconciler",
      terminalPostcondition: {
        kind: "rollback-restored",
        hash: HASH_C,
      },
      allowNonRoot: true,
    });
    assert.equal(terminal.state, "terminal");
    assert.deepEqual(terminal.terminalPostcondition, {
      kind: "rollback-restored",
      hash: HASH_C,
      recordedAt: "2026-07-10T04:00:33.000Z",
    });
    assert.equal(existsSync(join(stateDir, "lock.json")), true, "terminal does not unlock");

    const cleared = await reconcileProductionMutationLock({
      stateDir,
      nowMs: START_MS + 34_000,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(cleared.outcome, "cleared-terminal");
    assert.equal(existsSync(join(stateDir, "lock.json")), false);
    const archived = JSON.parse(
      await readFile(join(stateDir, "terminal", `${request().operationId}.json`), "utf8"),
    );
    assert.equal(archived.state, "terminal");
    assert.equal(archived.terminalPostcondition.kind, "rollback-restored");

    const unlocked = await reconcileProductionMutationLock({
      stateDir,
      nowMs: START_MS + 35_000,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(unlocked.outcome, "unlocked");
  });

  await withStateDir(async (stateDir) => {
    const outcomes = await Promise.allSettled(
      ["race-a", "race-b"].map((operationId) =>
        acquireProductionMutationLock({
          stateDir,
          request: request(operationId),
          nowMs: START_MS,
          allowNonRoot: true,
        }),
      ),
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  });

  await withStateDir(async (stateDir) => {
    await acquireProductionMutationLock({
      stateDir,
      request: request(),
      nowMs: START_MS,
      allowNonRoot: true,
    });
    await Promise.allSettled([
      markProductionMutationTerminal({
        stateDir,
        operationId: request().operationId,
        releaseHash: HASH_A,
        targetHash: HASH_B,
        nowMs: START_MS + 1_000,
        leaseOwner: "github:run-123",
        terminalPostcondition: { kind: "healthy-baseline", hash: HASH_C },
        allowNonRoot: true,
      }),
      verifyProductionMutationLock({
        stateDir,
        operationId: request().operationId,
        releaseHash: HASH_A,
        targetHash: HASH_B,
        nowMs: START_MS + 1_000,
        leaseOwner: "github:run-123",
        renewLeaseMs: 30_000,
        allowNonRoot: true,
      }),
    ]);
    const finalLock = await readProductionMutationLock({ stateDir, allowNonRoot: true });
    assert.equal(finalLock.state, "terminal", "lease renewal cannot overwrite a terminal record");
    assert.equal(finalLock.terminalPostcondition?.kind, "healthy-baseline");
  });

  await withStateDir(async (stateDir) => {
    writeFileSync(join(stateDir, "lock.json"), "{not-json", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      reconcileProductionMutationLock({
        stateDir,
        nowMs: START_MS,
        reconcilerOwner: "systemd:spx-production-mutation-reconciler",
        leaseDurationMs: 30_000,
        allowNonRoot: true,
      }),
      /production-mutation-lock-invalid/,
    );
    assert.equal(existsSync(join(stateDir, "lock.json")), true, "invalid locks fail closed");
  });

  await withStateDir(async (stateDir) => {
    const script = resolve("scripts/production-mutation-host-lock.mjs");
    const common = [
      `--root=${stateDir}`,
      "--operation-id=cli-install-001",
      `--release-sha256=${HASH_A}`,
      `--target-sha256=${HASH_B}`,
    ];
    const run = (args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: resolve("."),
        env: { ...process.env, NODE_ENV: "test" },
        encoding: "utf8",
      });
    const acquired = run([
      "--action=acquire",
      ...common,
      "--operation-type=install",
      `--rollback-journal-sha256=${HASH_C}`,
      `--rollback-image=${IMAGE_DIGEST}`,
      "--lease-seconds=30",
    ]);
    assert.equal(acquired.status, 1);
    assert.equal(acquired.stderr, "production-mutation-lock-failed\n");
    const acquiredWithVerifiedRollback = run([
      "--action=acquire",
      ...common,
      "--operation-type=install",
      `--rollback-journal-sha256=${HASH_C}`,
      `--rollback-image=${IMAGE_DIGEST}`,
      `--rollback-release-sha256=${HASH_B}`,
      `--rollback-service-set-sha256=${HASH_C}`,
      `--rollback-config-sha256=${HASH_A}`,
      "--lease-seconds=30",
    ]);
    assert.equal(acquiredWithVerifiedRollback.status, 0, acquiredWithVerifiedRollback.stderr);
    const verified = run(["--action=verify", ...common]);
    assert.equal(verified.status, 0, verified.stderr);
    const missingRollbackEvidence = run([
      "--action=terminal",
      ...common,
      "--postcondition=rolled-back",
    ]);
    assert.equal(missingRollbackEvidence.status, 1);
    assert.equal(missingRollbackEvidence.stderr, "production-mutation-lock-failed\n");
    const terminal = run(["--action=terminal", ...common, "--postcondition=healthy"]);
    assert.equal(terminal.status, 0, terminal.stderr);
    const reconciled = run(["--action=reconcile", `--root=${stateDir}`]);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(existsSync(join(stateDir, "lock.json")), false);
  });

  if (process.platform !== "win32") {
    await withStateDir(async (stateDir) => {
      const target = join(stateDir, "target.json");
      writeFileSync(target, "{}", "utf8");
      symlinkSync(target, join(stateDir, "lock.json"));
      await assert.rejects(
        readProductionMutationLock({ stateDir, allowNonRoot: true }),
        /production-mutation-lock-invalid/,
      );
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
