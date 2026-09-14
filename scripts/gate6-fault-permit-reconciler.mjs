#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { readGate6RuntimeContext } from "./lib/gate6-runtime-context.mjs";
import {
  createGate6MysqlLedger,
  createProductionGate6MysqlPool,
} from "./lib/gate6-mysql-ledger.mjs";

const EVIDENCE_FILE = "/var/lib/spx-gate6/evidence/rollback/fault-permits-disarmed.json";

export async function reconcileAllGate6FaultPermits(input) {
  const now = input.now ?? new Date();
  const result = await input.ledger.disarmAllTask9Permits({
    gate6Id: input.context.gate6Id,
    now,
  });
  if (result?.status !== "disarmed" || !Number.isSafeInteger(result.changedCount) || result.changedCount < 0) {
    throw new Error("Gate 6 fault permit reconciliation failed");
  }
  const evidenceSha256 = createHash("sha256").update(canonicalGate6Json({
    schemaVersion: 1,
    gate6Id: input.context.gate6Id,
    status: "disarmed",
  })).digest("hex");
  return {
    schemaVersion: 1,
    gate6Id: input.context.gate6Id,
    stepId: "fault-permits-disarmed",
    status: "complete",
    evidenceSha256,
    checkedAt: now.toISOString(),
  };
}

async function writeEvidence(value) {
  const directory = dirname(EVIDENCE_FILE);
  const directoryStat = await lstat(directory, { bigint: true });
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || (process.platform !== "win32" && directoryStat.uid !== 0n)
    || (process.platform !== "win32" && Number(directoryStat.mode & 0o077n) !== 0)
  ) throw new Error("Gate 6 rollback evidence directory is insecure");
  const handle = await open(
    EVIDENCE_FILE,
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

async function main() {
  let pool;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--action=disarm-all") {
      throw new Error("Gate 6 fault permit reconciler arguments are invalid");
    }
    const context = await readGate6RuntimeContext();
    pool = await createProductionGate6MysqlPool({
      runtime: "host",
      expectedTargetDescriptorSha256: context.targetDescriptorSha256,
    });
    const evidence = await reconcileAllGate6FaultPermits({
      context,
      ledger: createGate6MysqlLedger(pool),
    });
    await writeEvidence(evidence);
    process.stdout.write(`${canonicalGate6Json({ ok: true, evidenceSha256: evidence.evidenceSha256 })}\n`);
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-fault-permit-reconciler-refused" })}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
