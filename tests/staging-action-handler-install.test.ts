import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import {
  STAGING_ACTION_HANDLER_MANIFEST,
  handlerWrapperSource,
  validateStagingActionHandlerManifest,
} from "../scripts/lib/staging-action-handler-manifest.mjs";
import {
  installStagingActionHandlers,
  validateStagingOperatorReleaseIdentity,
  verifyInstalledStagingActionHandlers,
} from "../scripts/install-staging-action-handlers.mjs";

const OPERATOR = "scripts";
const expected = [
  ["staging-db-bootstrap", `${OPERATOR}/a3-staging-db-provision.mjs`, ["db-bootstrap"]],
  ["staging-db-migrate", `${OPERATOR}/a3-staging-db-provision.mjs`, ["db-migrate"]],
  ["staging-db-finalize", `${OPERATOR}/a3-staging-db-provision.mjs`, ["db-finalize"]],
  ["staging-db-bootstrap-revoke", `${OPERATOR}/a3-staging-db-provision.mjs`, ["db-bootstrap-revoke"]],
  ["staging-runtime-start", `${OPERATOR}/staging-core-action-handler.mjs`, []],
  ["staging-gate-1-baseline", `${OPERATOR}/staging-gate-evidence-check.mjs`, []],
  ["staging-controlled-publish", `${OPERATOR}/staging-core-action-handler.mjs`, []],
  ["staging-line-fault", `${OPERATOR}/a3-staging-service-fault.mjs`, ["line-fault"]],
  ["staging-line-recovery", `${OPERATOR}/a3-staging-service-fault.mjs`, ["line-recover"]],
  ["staging-ocr-fault", `${OPERATOR}/a3-staging-service-fault.mjs`, ["ocr-fault"]],
  ["staging-ocr-recovery", `${OPERATOR}/a3-staging-service-fault.mjs`, ["ocr-recover"]],
  ["staging-worker-forward-handoff", `${OPERATOR}/staging-core-action-handler.mjs`, []],
  ["staging-worker-reverse-handoff", `${OPERATOR}/staging-core-action-handler.mjs`, []],
  ["staging-gate-2-worker", `${OPERATOR}/staging-gate-evidence-check.mjs`, []],
  ["staging-gate-3-handoff", `${OPERATOR}/staging-gate-evidence-check.mjs`, []],
  ["phase3-consumer-start-disabled", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-legacy-lease-release", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-poller-start", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-publication-enable", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-execution-enable", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-publication-fence", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-drain-or-quarantine", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["phase3-inline-owner-restore", `${OPERATOR}/staging-phase3-action-handler.mjs`, []],
  ["staging-gate-4-phase3", `${OPERATOR}/staging-gate-evidence-check.mjs`, []],
  ["phase4-n1-preflight", `${OPERATOR}/phase4-n-minus-one-rehearsal.mjs`, []],
  ["phase4-n1-start", `${OPERATOR}/phase4-n-minus-one-rehearsal.mjs`, []],
  ["phase4-n1-verify", `${OPERATOR}/phase4-n-minus-one-rehearsal.mjs`, []],
  ["phase4-n1-rollback-forward", `${OPERATOR}/phase4-n-minus-one-rehearsal.mjs`, []],
  ["phase4-n1-stop", `${OPERATOR}/phase4-n-minus-one-rehearsal.mjs`, []],
  ["phase4-proxy-realtime-start", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-singleton-contender-probe", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-route-producer", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-route-read", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-route-stream", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-realtime-restart-probe", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-route-local-rollback", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-route-approved-final", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["phase4-db-proxy-fault", `${OPERATOR}/a3-staging-db-fault.mjs`, ["fault"]],
  ["phase4-db-proxy-recover", `${OPERATOR}/a3-staging-db-fault.mjs`, ["recover"]],
  ["phase4-route-final-cleanup-baseline", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["staging-final-stop", `${OPERATOR}/a3-capacity-guard.mjs`, ["stop"]],
  ["guard-close", `${OPERATOR}/phase4-staging-action-handler.mjs`, []],
  ["staging-guard-emergency-stop", `${OPERATOR}/a3-capacity-guard.mjs`, ["stop"]],
  ["staging-watchdog-emergency-stop", `${OPERATOR}/a3-capacity-guard.mjs`, ["stop"]],
] as const;

async function main(): Promise<void> {
  assert.equal(REQUIRED_STAGING_ACTION_PLAN.length, 44);
  assert.deepEqual(validateStagingActionHandlerManifest(), STAGING_ACTION_HANDLER_MANIFEST);
  assert.deepEqual(
    STAGING_ACTION_HANDLER_MANIFEST.map(({ actionId, script, argv }) => [actionId, script, argv]),
    expected,
  );
  assert.deepEqual(
    STAGING_ACTION_HANDLER_MANIFEST.map((entry) => entry.actionId),
    REQUIRED_STAGING_ACTION_PLAN.map((action) => action.actionId),
  );
  assert.equal(new Set(STAGING_ACTION_HANDLER_MANIFEST.map((entry) => entry.actionId)).size, 44);
  assert.equal(
    STAGING_ACTION_HANDLER_MANIFEST.some(({ actionId }) =>
      ["phase3-schema-verify", "phase3-fence-ack-wait"].includes(actionId)),
    false,
  );

  for (const entry of STAGING_ACTION_HANDLER_MANIFEST) {
    const wrapper = handlerWrapperSource(entry);
    assert.match(wrapper, /^#!\/usr\/bin\/node\n/);
    assert.match(wrapper, /process\.argv\.length !== 2/);
    assert.match(wrapper, /spawnSync\("\/usr\/bin\/node"/);
    assert.match(wrapper, /\/proc\/.*cmdline/);
    assert.match(wrapper, /\/opt\\\/spx-staging\\\/release\\\/\[0-9a-f\]\{40\}\\\/operator/);
    assert.match(wrapper, /shell: false/);
    assert.doesNotMatch(wrapper, /\$\{|`|shell:\s*true|execSync|process\.argv\.slice/);
    assert.match(wrapper, new RegExp(JSON.stringify(entry.actionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const temp = await mkdtemp(join(tmpdir(), "spx-staging-handlers-"));
  const sourceRoot = join(temp, "operator");
  const handlerRoot = join(temp, "libexec", "spx-staging-actions");
  const expectedUid = process.platform === "win32" ? null : process.getuid!();
  try {
    for (const script of new Set(STAGING_ACTION_HANDLER_MANIFEST.map((entry) => entry.script))) {
      const relative = script.slice(`${OPERATOR}/`.length);
      const path = join(sourceRoot, script);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `fixture:${relative}\n`, "utf8");
      if (process.platform !== "win32") await chmod(path, 0o444);
    }
    await mkdir(join(temp, "libexec"), { recursive: true });

    const installed = await installStagingActionHandlers({ sourceRoot, handlerRoot, expectedUid });
    assert.deepEqual(installed, { ok: true, count: 44, installed: true });
    assert.deepEqual(await verifyInstalledStagingActionHandlers({
      handlerRoot,
      expectedUid,
    }), {
      ok: true,
      count: 44,
    });
    assert.equal(
      await readFile(join(handlerRoot, "staging-db-bootstrap"), "utf8"),
      handlerWrapperSource(STAGING_ACTION_HANDLER_MANIFEST[0]),
    );
    const callerArgument = spawnSync(
      process.execPath,
      [join(handlerRoot, "staging-db-bootstrap"), "caller-argument"],
      {
        env: {
          PATH: process.env.PATH,
          SPX_STAGING_ACTION_ID: "staging-db-bootstrap",
          SPX_STAGING_ACTION_SCOPE: "database-bootstrap",
          SPX_STAGING_RUN_ID: "staging-run-001",
        },
      },
    );
    assert.equal(callerArgument.status, 64);
    assert.deepEqual(await installStagingActionHandlers({ sourceRoot, handlerRoot, expectedUid }), {
      ok: true,
      count: 44,
      installed: false,
    });
    const nextSourceRoot = join(temp, "next-operator");
    for (const script of new Set(STAGING_ACTION_HANDLER_MANIFEST.map((entry) => entry.script))) {
      const path = join(nextSourceRoot, script);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "fixture:next-release\n", "utf8");
      if (process.platform !== "win32") await chmod(path, 0o444);
    }
    assert.deepEqual(
      await installStagingActionHandlers({
        sourceRoot: nextSourceRoot,
        handlerRoot,
        expectedUid,
      }),
      { ok: true, count: 44, installed: false },
    );

    await chmod(join(handlerRoot, "staging-db-bootstrap"), 0o666);
    await writeFile(join(handlerRoot, "staging-db-bootstrap"), "tampered\n", "utf8");
    await chmod(join(handlerRoot, "staging-db-bootstrap"), 0o555);
    await assert.rejects(
      verifyInstalledStagingActionHandlers({ handlerRoot, expectedUid }),
      /content|tamper|checksum/i,
    );
    await assert.rejects(
      installStagingActionHandlers({ sourceRoot, handlerRoot, expectedUid }),
      /content|tamper|checksum/i,
    );

    await chmod(handlerRoot, 0o755);
    await rm(handlerRoot, { recursive: true, force: true });
    await installStagingActionHandlers({ sourceRoot, handlerRoot, expectedUid });
    await chmod(handlerRoot, 0o755);
    await unlink(join(handlerRoot, "staging-db-bootstrap"));
    await chmod(handlerRoot, 0o555);
    await assert.rejects(
      verifyInstalledStagingActionHandlers({ handlerRoot, expectedUid }),
      /coverage|missing/i,
    );

    await chmod(handlerRoot, 0o755);
    await rm(handlerRoot, { recursive: true, force: true });
    await installStagingActionHandlers({ sourceRoot, handlerRoot, expectedUid });
    await chmod(handlerRoot, 0o755);
    await writeFile(join(handlerRoot, "unreviewed-action"), "#!/usr/bin/node\n", "utf8");
    await chmod(join(handlerRoot, "unreviewed-action"), 0o555);
    await chmod(handlerRoot, 0o555);
    await assert.rejects(
      verifyInstalledStagingActionHandlers({ handlerRoot, expectedUid }),
      /coverage|extra/i,
    );
  } finally {
    await chmod(handlerRoot, 0o755).catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }

  const sourceSha = "a".repeat(40);
  const releaseManifest = {
    sourceSha,
    operatorBundleSha256: "b".repeat(64),
  };
  const releaseBytes = Buffer.from(JSON.stringify(releaseManifest));
  const context = {
    schemaVersion: 1,
    target: "staging",
    sourceSha,
    composeProject: "spx-staging",
    releaseRoot: "/opt/spx-staging/release",
    releaseManifestSha256: createHash("sha256").update(releaseBytes).digest("hex"),
    operatorBundleSha256: releaseManifest.operatorBundleSha256,
  };
  assert.equal(
    validateStagingOperatorReleaseIdentity(
      `/opt/spx-staging/release/${sourceSha}/operator`,
      releaseBytes,
      context,
    ).sourceSha,
    sourceSha,
  );
  assert.throws(
    () => validateStagingOperatorReleaseIdentity(
      "/opt/spx-staging/operator",
      releaseBytes,
      context,
    ),
    /release|operator root/i,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
