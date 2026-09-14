#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import {
  evaluateRollbackScope,
  loadPhase3PublicationSnapshot,
  parseCli,
} from "./phase3-publication-control.mjs";

export function evaluatePhase3RollbackGuard(input) {
  return evaluateRollbackScope(input);
}

function parseGuardCli(argv) {
  if (!Array.isArray(argv)) throw new Error("invalid rollback guard arguments");
  const dryRun = argv.includes("--dry-run");
  const scoped = argv.filter((argument) => argument !== "--dry-run");
  if (scoped.length !== argv.length - (dryRun ? 1 : 0)) {
    throw new Error("invalid rollback guard arguments");
  }
  const parsed = parseCli([
    `--action=${dryRun ? "dry-run" : "status"}`,
    ...scoped,
  ]);
  return { ...parsed, dryRun };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function helpText() {
  return `phase3-rollback-guard.mjs

Read-only rollback guard scoped to one active team, epoch, generation, and
poller identity. Inline execution remains blocked until the publication fence
is acknowledged and exact scoped queue, claim, ambiguity, and settlement work
is zero or explicitly quarantined.

Usage:
  node scripts/phase3-rollback-guard.mjs --team-id=2 --epoch=EPOCH --poller-node-id=NODE
  node scripts/phase3-rollback-guard.mjs --dry-run --team-id=2 --epoch=EPOCH --poller-node-id=NODE
`;
}

async function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    process.stdout.write(helpText());
    return;
  }
  try {
    const args = parseGuardCli(process.argv.slice(2));
    const database = mysqlScriptConnectionConfigFromEnv();
    if (args.dryRun || database.missing.length > 0) {
      const ok = database.missing.length === 0;
      print({
        ok,
        dryRun: args.dryRun,
        missingDbEnv: database.missing,
        teamId: args.teamId,
        epoch: args.epoch,
        pollerNodeId: args.pollerNodeId,
      });
      if (!ok) process.exitCode = 1;
      return;
    }
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection(database.value);
    try {
      const snapshot = await loadPhase3PublicationSnapshot(connection, args);
      const result = evaluatePhase3RollbackGuard(snapshot);
      print({
        ...result,
        teamId: args.teamId,
        epoch: args.epoch,
        generation: snapshot.expected.generation,
        checkedAt: new Date().toISOString(),
        mode: "mysql",
      });
      if (!result.ok) process.exitCode = 1;
    } finally {
      await connection.end();
    }
  } catch {
    print({ ok: false, code: "PHASE3_ROLLBACK_GUARD_QUERY_FAILED" });
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) void main();
