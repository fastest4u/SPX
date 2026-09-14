import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  candidateGate6ComposePrefix,
  gate6InstanceUnit,
  verifyGate6SupervisorInstall,
} from "../scripts/lib/gate6-immutable-runtime.mjs";
import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const CANDIDATE = "a".repeat(40);
const ROLLBACK = "b".repeat(40);
const BUNDLE = "c".repeat(64);

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "spx-gate6-immutable-"));
  const releaseParent = join(temporary, "releases");
  const supervisorParent = join(temporary, "supervisors");
  const release = join(releaseParent, CANDIDATE);
  const operator = join(release, "operator");
  const supervisor = join(supervisorParent, CANDIDATE);
  await mkdir(join(operator), { recursive: true, mode: 0o700 });
  await mkdir(join(supervisor, "scripts"), { recursive: true, mode: 0o700 });
  const source = "export const immutable = true;\n";
  await writeFile(join(operator, "docker-compose.yml"), "services: {}\n", { mode: 0o444 });
  await writeFile(join(supervisor, "scripts", "gate6-host-watchdog.mjs"), source, { mode: 0o444 });
  const index = {
    schemaVersion: 1,
    format: "ustar",
    files: [{
      path: "scripts/gate6-host-watchdog.mjs",
      sha256: sha256(source),
      size: Buffer.byteLength(source),
      mode: "0644",
    }],
  };
  const indexText = canonicalGate6Json(index);
  await writeFile(join(supervisor, "operator-bundle.index.json"), indexText, { mode: 0o444 });
  await writeFile(join(release, "deployment-context.json"), JSON.stringify({
    sourceSha: CANDIDATE,
    operatorBundleSha256: BUNDLE,
    operatorIndexSha256: sha256(indexText),
  }), { mode: 0o444 });
  const environmentFile = join(temporary, "runtime.env");
  await writeFile(environmentFile, "SPX_DB_HOST=127.0.0.1\n", { mode: 0o400 });
  if (process.platform !== "win32") {
    await chmod(temporary, 0o700);
    await chmod(releaseParent, 0o700);
    await chmod(supervisorParent, 0o700);
  }

  const context = {
    candidateSha: CANDIDATE,
    rollbackSha: ROLLBACK,
    operatorBundleSha256: BUNDLE,
  };
  const verified = await verifyGate6SupervisorInstall({
    instance: CANDIDATE,
    context,
    releaseParent,
    supervisorParent,
    environmentFile,
    requiredEntrypoints: ["scripts/gate6-host-watchdog.mjs"],
    allowNonRoot: true,
  });
  assert.equal(verified.supervisorRoot, supervisor);
  assert.equal(verified.candidateOperatorRoot, operator);
  assert.deepEqual(candidateGate6ComposePrefix(verified), [
    "compose", "--project-name", "spx-production",
    "--env-file", environmentFile,
    "--file", join(operator, "docker-compose.yml"),
  ]);
  assert.equal(gate6InstanceUnit("monitor", CANDIDATE), `spx-gate6-monitor@${CANDIDATE}.service`);
  assert.throws(() => gate6InstanceUnit("monitor", ROLLBACK, context), /context|instance/i);

  const installedWatchdog = join(supervisor, "scripts", "gate6-host-watchdog.mjs");
  await chmod(installedWatchdog, 0o600);
  await writeFile(installedWatchdog, "tampered\n");
  await assert.rejects(() => verifyGate6SupervisorInstall({
    instance: CANDIDATE,
    context,
    releaseParent,
    supervisorParent,
    environmentFile,
    requiredEntrypoints: ["scripts/gate6-host-watchdog.mjs"],
    allowNonRoot: true,
  }), /checksum|size/i);

  const guardedFiles = [
    "scripts/gate6-runtime-control.mjs",
    "scripts/gate6-host-watchdog.mjs",
    "scripts/production-canary-monitor.mjs",
    "scripts/gate6-rollback-coordinator.mjs",
    "scripts/production-db-principal-controller.mjs",
    "scripts/production-worker-canary-control.mjs",
    "scripts/production-phase3-controller.mjs",
    "scripts/production-phase4-controller.mjs",
  ];
  for (const path of guardedFiles) {
    assert.doesNotMatch(await readFile(path, "utf8"), /\/root\/SPX/,
      `${path} must not follow the mutable production projection`);
  }
  console.log("Gate 6 immutable runtime tests passed");
}

void main();
