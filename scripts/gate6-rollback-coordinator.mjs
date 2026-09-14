#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { readGate6RuntimeContext } from "./lib/gate6-runtime-context.mjs";
import {
  parseGate6InstanceArguments,
  verifyGate6SupervisorInstall,
} from "./lib/gate6-immutable-runtime.mjs";
import {
  createGate6MysqlLedger,
  createProductionGate6MysqlPool,
} from "./lib/gate6-mysql-ledger.mjs";
import { readEvidenceBytes } from "./lib/evidence-artifact.mjs";

export const ROLLBACK_STEP_IDS = Object.freeze([
  "phase4-local-routing",
  "phase3-inline-owner",
  "worker-prior-owner",
  "fault-permits-disarmed",
  "legacy-db-principals",
  "rollback-release-image",
]);

export async function convergeGate6Rollback({ adapters, journal }) {
  for (const stepId of ROLLBACK_STEP_IDS) {
    const adapter = adapters?.[stepId];
    if (!adapter || typeof adapter.inspect !== "function" || typeof adapter.converge !== "function") {
      throw new Error(`rollback adapter is missing for ${stepId}`);
    }
    const state = await adapter.inspect();
    if (state === "indeterminate") throw new Error(`rollback state is indeterminate at ${stepId}`);
    if (state === "complete") continue;
    if (state !== "needed") throw new Error(`rollback state is invalid at ${stepId}`);
    await adapter.converge();
    if (typeof adapter.verify !== "function" || await adapter.verify() !== true) {
      throw new Error(`rollback postcondition failed at ${stepId}`);
    }
    await journal.record(stepId);
  }
  return { status: "compensated", steps: [...ROLLBACK_STEP_IDS] };
}

export async function superviseGate6RollbackOnce(input) {
  const state = await input.ledger.getSupervisorState(input.context.gate6Id);
  if (["active", "sealed-verifying", "releasing"].includes(state.status)) {
    return { status: "waiting" };
  }
  if (["released", "rolled-back"].includes(state.status)) return { status: state.status };
  if (state.status !== "revoked") throw new Error("Gate 6 rollback supervisor run state is invalid");
  const result = await input.converge();
  if (result?.status !== "compensated" || canonicalGate6Json(result.steps) !== canonicalGate6Json(ROLLBACK_STEP_IDS)) {
    throw new Error("Gate 6 rollback convergence result is invalid");
  }
  const rollbackEvidenceSha256 = createHash("sha256")
    .update(canonicalGate6Json({
      schemaVersion: 1,
      gate6Id: input.context.gate6Id,
      result,
    }))
    .digest("hex");
  await input.ledger.completeRollback({
    gate6Id: input.context.gate6Id,
    rollbackEvidenceSha256,
    now: input.now ?? new Date(),
  });
  return { status: "rolled-back", rollbackEvidenceSha256 };
}

const ARTIFACT_ROOT = "/var/lib/spx-gate6/artifacts";
const ACTION_ROOT = "/var/lib/spx-gate6/actions";
const POSTPROOF_BUNDLE = "/var/lib/spx-gate6/postproof/postproof-actions.json";
const EVIDENCE_ROOT = "/var/lib/spx-gate6/evidence/rollback";
const JOURNAL_FILE = "/var/lib/spx-gate6/rollback-journal.ndjson";
const COMMANDS = Object.freeze({
  "phase4-local-routing": [[
    "scripts/production-phase4-controller.mjs", "--action=restore-local-routing",
    `--envelope=${ARTIFACT_ROOT}/gate6-envelope.json`,
    `--action-approval=${ACTION_ROOT}/phase4-restore-local-routing.json`,
    `--release=${ARTIFACT_ROOT}/release-manifest.json`,
  ]],
  "phase3-inline-owner": [[
    "scripts/production-phase3-controller.mjs", "--action=restore-inline-owner",
    `--envelope=${ARTIFACT_ROOT}/gate6-envelope.json`,
    `--action-approval=${ACTION_ROOT}/phase3-restore-inline-owner.json`,
    `--release=${ARTIFACT_ROOT}/release-manifest.json`,
  ]],
  "worker-prior-owner": [
    [
      "scripts/production-worker-canary-control.mjs", "--action=restore-prior",
      `--envelope=${ARTIFACT_ROOT}/gate6-envelope.json`,
      `--action-approval=${ACTION_ROOT}/worker-ifn-restore-prior.json`,
      `--release=${ARTIFACT_ROOT}/release-manifest.json`,
    ],
    [
      "scripts/production-worker-canary-control.mjs", "--action=restore-prior",
      `--envelope=${ARTIFACT_ROOT}/gate6-envelope.json`,
      `--action-approval=${ACTION_ROOT}/worker-ptwl-restore-prior.json`,
      `--release=${ARTIFACT_ROOT}/release-manifest.json`,
    ],
  ],
  "fault-permits-disarmed": [[
    "scripts/gate6-fault-permit-reconciler.mjs", "--action=disarm-all",
  ]],
  "legacy-db-principals": [[
    "scripts/production-db-principal-controller.mjs", "--action=restore-legacy",
    `--postproof-bundle=${POSTPROOF_BUNDLE}`,
    `--envelope=${ARTIFACT_ROOT}/gate6-envelope.json`,
    `--release=${ARTIFACT_ROOT}/release-manifest.json`,
  ], ...[
    ["realtime-service", "db-principal-restore-realtime.json"],
    ["line-service", "db-principal-restore-line.json"],
    ["notification-service", "db-principal-restore-notification.json"],
    ["worker-ifn-split", "db-principal-restore-worker-ifn.json"],
    ["worker-ptwl-split", "db-principal-restore-worker-ptwl.json"],
    ["web-api", "db-principal-restore-web.json"],
    ["phase3-control", "db-principal-restore-phase3-control.json"],
  ].map(([role, approval]) => [
    "scripts/production-db-principal-controller.mjs", "--action=restore-role", `--role=${role}`,
    `--envelope=${ARTIFACT_ROOT}/gate6-envelope.json`,
    `--action-approval=${ACTION_ROOT}/${approval}`,
    `--release=${ARTIFACT_ROOT}/release-manifest.json`,
  ])],
  "rollback-release-image": [[
    "scripts/production-project-identity.mjs", "--action=rollback",
    `--approval=${ARTIFACT_ROOT}/production-project-approval.json`,
    `--release-manifest=${ARTIFACT_ROOT}/release-manifest.json`,
  ]],
});

function runController(operatorRoot, argv, spawnImpl = spawn) {
  const scriptPath = resolve(operatorRoot, argv[0]);
  if (relative(operatorRoot, scriptPath).startsWith("..")) {
    throw new Error("Gate 6 rollback controller path escapes the immutable install");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(process.execPath, [scriptPath, ...argv.slice(1)], {
      cwd: operatorRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
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
        rejectPromise(new Error("Gate 6 rollback controller failed"));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try {
        const value = JSON.parse(text);
        if (canonicalGate6Json(value) !== text || value?.ok !== true) {
          throw new Error("invalid output");
        }
        resolvePromise(createHash("sha256").update(text).digest("hex"));
      } catch {
        rejectPromise(new Error("Gate 6 rollback controller output is invalid"));
      }
    });
  });
}

async function inspectRollbackEvidence(stepId, gate6Id) {
  const path = `${EVIDENCE_ROOT}/${stepId}.json`;
  let bytes;
  try {
    bytes = await readEvidenceBytes(path, { maxFileBytes: 64 * 1024 });
  } catch (error) {
    if (error?.code === "ENOENT") return "needed";
    return "indeterminate";
  }
  try {
    const text = bytes.toString("utf8");
    const value = JSON.parse(text);
    if (
      text !== canonicalGate6Json(value)
      || canonicalGate6Json(Object.keys(value).sort()) !== canonicalGate6Json([
        "schemaVersion", "gate6Id", "stepId", "status", "evidenceSha256", "checkedAt",
      ].sort())
      || value.schemaVersion !== 1
      || value.gate6Id !== gate6Id
      || value.stepId !== stepId
      || value.status !== "complete"
      || !/^[0-9a-f]{64}$/.test(value.evidenceSha256 ?? "")
      || !Number.isFinite(Date.parse(value.checkedAt ?? ""))
    ) return "indeterminate";
    return "complete";
  } catch {
    return "indeterminate";
  }
}

async function writeRollbackStepEvidence(stepId, gate6Id, outputHashes) {
  if (await inspectRollbackEvidence(stepId, gate6Id) === "complete") return;
  const path = `${EVIDENCE_ROOT}/${stepId}.json`;
  const directoryStat = await lstat(dirname(path), { bigint: true });
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || (process.platform !== "win32" && directoryStat.uid !== 0n)
    || (process.platform !== "win32" && Number(directoryStat.mode & 0o077n) !== 0)
  ) throw new Error("Gate 6 rollback evidence directory is insecure");
  const evidenceSha256 = createHash("sha256").update(canonicalGate6Json({
    schemaVersion: 1,
    gate6Id,
    stepId,
    outputHashes,
  })).digest("hex");
  const value = {
    schemaVersion: 1,
    gate6Id,
    stepId,
    status: "complete",
    evidenceSha256,
    checkedAt: new Date().toISOString(),
  };
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(canonicalGate6Json(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFixedGate6RollbackAdapters(context, options = {}) {
  if (!options.operatorRoot) throw new Error("Gate 6 rollback immutable operator root is required");
  return Object.freeze(Object.fromEntries(ROLLBACK_STEP_IDS.map((stepId) => [stepId, {
    inspect: () => inspectRollbackEvidence(stepId, context.gate6Id),
    async converge() {
      const outputHashes = [];
      for (const command of COMMANDS[stepId]) {
        outputHashes.push(await runController(options.operatorRoot, command, options.spawnImpl));
      }
      await writeRollbackStepEvidence(stepId, context.gate6Id, outputHashes);
    },
    async verify() {
      return await inspectRollbackEvidence(stepId, context.gate6Id) === "complete";
    },
  }])));
}

async function appendRollbackJournal(stepId, gate6Id) {
  try {
    const stat = await lstat(JOURNAL_FILE, { bigint: true });
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || (process.platform !== "win32" && stat.uid !== 0n)
      || (process.platform !== "win32" && Number(stat.mode & 0o077n) !== 0)
    ) throw new Error("Gate 6 rollback journal is insecure");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(
    JOURNAL_FILE,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalGate6Json({ gate6Id, stepId, completedAt: new Date().toISOString() })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function runGate6RollbackSupervisorLoop(input) {
  const intervalMs = input.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 30_000) {
    throw new Error("Gate 6 rollback supervisor interval is invalid");
  }
  while (true) {
    const result = await superviseGate6RollbackOnce({
      context: input.context,
      ledger: input.ledger,
      converge: () => convergeGate6Rollback({ adapters: input.adapters, journal: input.journal }),
    });
    if (["released", "rolled-back"].includes(result.status)) return result;
    await (input.sleep ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))))(intervalMs);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    let pool;
    try {
      const instance = parseGate6InstanceArguments(process.argv.slice(2), "--supervise");
      const context = await readGate6RuntimeContext();
      const install = await verifyGate6SupervisorInstall({ instance, context });
      pool = await createProductionGate6MysqlPool({
        runtime: "host",
        expectedTargetDescriptorSha256: context.targetDescriptorSha256,
      });
      const result = await runGate6RollbackSupervisorLoop({
        context,
        ledger: createGate6MysqlLedger(pool),
        adapters: createFixedGate6RollbackAdapters(context, { operatorRoot: install.supervisorRoot }),
        journal: { record: (stepId) => appendRollbackJournal(stepId, context.gate6Id) },
      });
      process.stdout.write(`${canonicalGate6Json({ ok: true, status: result.status })}\n`);
    } catch {
      process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-rollback-supervisor-refused" })}\n`);
      process.exitCode = 1;
    } finally {
      if (pool) await pool.end();
    }
  })();
}
