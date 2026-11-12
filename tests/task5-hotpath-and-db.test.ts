process.env.DB_MODE = "memory";
process.env.NODE_ENV = "test";
process.env.SECRETS_KEY = "task5-hotpath-and-db-secrets-key-32ch!";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closePool, ensureDashboardTables } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { env } from "../src/config/env.js";
import { TeamRuntime } from "../src/services/team-runtime.js";
import { clearTeamCredentialPools } from "../src/services/team-credential-pool.js";
import { createTeam } from "../src/repositories/team-repository.js";
import {
  getRealtimeEventByEventId,
  persistRealtimeEnvelope,
  pruneNonReplayableRealtimeEvents,
} from "../src/repositories/realtime-event-repository.js";
import type { RealtimeEnvelopeV1 } from "../src/services/realtime-contract.js";
import { assertDbResetAllowed } from "../src/scripts/db-reset.js";

async function testTeamRuntimeNonBlockingAccountRefresh(): Promise<void> {
  await closePool();
  resetMemoryDb();
  await ensureDashboardTables();
  clearTeamCredentialPools();

  const mutableEnv = env as unknown as Record<string, unknown>;
  const savedApiUrl = mutableEnv.API_URL;
  const savedFetch = globalThis.fetch;

  mutableEnv.API_URL = "https://spx.example.test/booking/bidding/list";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ retcode: 0, data: { list: [], total: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const team = await createTeam({
    name: "Fast Poll Team",
    enabled: true,
    spxCookie: "SPC_EC=fast-cookie",
    spxDeviceId: "fast-device",
    lineGroupId: "",
  });

  const runtime = new TeamRuntime(
    {
      id: team.id,
      name: team.name,
      enabled: true,
      spxCookie: "SPC_EC=fast-cookie",
      spxDeviceId: "fast-device",
      lineGroupId: "",
      autoAcceptSuccessLineGroupId: "",
      autoAcceptFailureLineGroupId: "",
      rateLimitNotifyEnabled: false,
      biddingVehicleType: 13,
    },
    { intervalSec: 60 },
  );

  try {
    await runtime.start();
    const pool = runtime.getCredentialPool();
    assert.ok(pool, "Expected TeamCredentialPool to be initialized");

    let reloadStarted = 0;
    let reloadCompleted = 0;
    pool.reloadAccounts = async () => {
      reloadStarted += 1;
      await new Promise((r) => setTimeout(r, 350));
      reloadCompleted += 1;
    };

    // Force periodic refresh threshold (> 30s) and invoke poller's beforePoll hook
    (runtime as unknown as { lastAccountReloadAt: number }).lastAccountReloadAt = Date.now() - 35_000;
    const poller = (runtime as unknown as { poller: { context?: { beforePoll?: () => Promise<boolean> } } }).poller;
    // Read beforePoll from internal Poller instance
    const beforePoll = (
      poller as unknown as Record<string, unknown>
    ).beforePoll as (() => Promise<boolean>) | undefined
      ?? ((poller as unknown as { teamContext?: { beforePoll?: () => Promise<boolean> } }).teamContext?.beforePoll);
    assert.equal(typeof beforePoll, "function", "Expected Poller beforePoll callback");

    const t0 = Date.now();
    const allowed = await beforePoll!();
    const elapsedMs = Date.now() - t0;

    assert.equal(allowed, true);
    assert.equal(reloadStarted, 1, "Expected background reloadAccounts() to start");
    assert.ok(
      elapsedMs < 100,
      `Expected beforePoll() not to block on 350ms DB reload, but took ${elapsedMs}ms`,
    );

    await runtime.stop();
    assert.equal(reloadCompleted, 1, "Expected in-flight reloadAccounts() to settle cleanly on stop()");
  } finally {
    await runtime.stop().catch(() => {});
    clearTeamCredentialPools();
    mutableEnv.API_URL = savedApiUrl;
    globalThis.fetch = savedFetch;
  }
}

function testBookingHistoryNoRedundantSelectBeforeInsertIgnore(): void {
  const repoSource = readFileSync(
    resolve(process.cwd(), "src/repositories/booking-history-repository.ts"),
    "utf8",
  );
  assert.equal(
    /findExistingBookingHistoryRequestIds/.test(repoSource),
    false,
    "insertBookingHistories should rely directly on INSERT IGNORE affectedRows without a redundant prior SELECT",
  );
}

function testDbResetProductionGuard(): void {
  assert.throws(
    () => assertDbResetAllowed({ NODE_ENV: "production" }),
    /ALLOW_PRODUCTION_DB_RESET/,
    "db-reset must refuse to run in production without ALLOW_PRODUCTION_DB_RESET=true",
  );
  assert.doesNotThrow(() =>
    assertDbResetAllowed({ NODE_ENV: "production", ALLOW_PRODUCTION_DB_RESET: "true" }),
  );
  assert.doesNotThrow(() => assertDbResetAllowed({ NODE_ENV: "development" }));
}

async function testPruneNonReplayableRealtimeEvents(): Promise<void> {
  await closePool();
  resetMemoryDb();
  await ensureDashboardTables();

  const makeMetricEnvelope = (idSuffix: string, replayable: boolean): RealtimeEnvelopeV1 => ({
    id: `metrics.snapshot:team-9:${idSuffix}`,
    idempotencyKey: `metrics:team-9:${idSuffix}`,
    type: "metrics.snapshot",
    envelopeVersion: 1,
    payloadVersion: 1,
    emittedAt: "2026-11-10T00:00:00.000Z",
    receivedAt: "2026-11-10T00:00:00.000Z",
    scope: { kind: "team", teamId: 9 },
    source: { service: "poller-service", nodeId: "worker-9", role: "worker" },
    replayable,
    payload: { snapshot: { teamId: 9 } },
  });

  await persistRealtimeEnvelope(makeMetricEnvelope("non-replay-old", false));
  await persistRealtimeEnvelope(makeMetricEnvelope("replay-keep", true));

  // Pruning 2 days in the future should remove expired replayable=0 rows while leaving replayable=1 intact
  await pruneNonReplayableRealtimeEvents({
    now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });

  assert.equal(
    await getRealtimeEventByEventId("metrics.snapshot:team-9:non-replay-old"),
    null,
    "Expired non-replayable realtime_events row should be pruned",
  );
  assert.ok(
    await getRealtimeEventByEventId("metrics.snapshot:team-9:replay-keep"),
    "Replayable realtime_events row must not be touched by pruneNonReplayableRealtimeEvents",
  );
}

function testMigration046AndSchemaVerifierAlignment(): void {
  const migrationPath = resolve(
    process.cwd(),
    "migrations/046_reconcile_team_spx_accounts_columns.sql",
  );
  assert.equal(
    existsSync(migrationPath),
    true,
    "Expected migrations/046_reconcile_team_spx_accounts_columns.sql to exist",
  );

  const migrationSql = readFileSync(migrationPath, "utf8");
  const verifierSource = readFileSync(resolve(process.cwd(), "scripts/schema-verify.mjs"), "utf8");
  const checksums = JSON.parse(
    readFileSync(resolve(process.cwd(), "migrations/released-checksums.json"), "utf8"),
  ) as Record<string, string>;

  assert.ok(
    checksums["046_reconcile_team_spx_accounts_columns.sql"],
    "046_reconcile_team_spx_accounts_columns.sql must be registered in migrations/released-checksums.json",
  );
  assert.match(verifierSource, /\bteam_spx_accounts\b/, "schema-verify.mjs must verify team_spx_accounts");
  assert.match(verifierSource, /\brate_limit_notify_enabled\b/, "schema-verify.mjs must verify teams.rate_limit_notify_enabled");
  assert.match(verifierSource, /\bbidding_vehicle_type\b/, "schema-verify.mjs must verify teams.bidding_vehicle_type");

  for (const col of [
    "spx_email",
    "spx_password",
    "spx_auth_status",
    "spx_auth_error",
    "spx_session_expires_at",
    "spx_last_login_at",
  ]) {
    assert.match(migrationSql, new RegExp(`\\b${col}\\b`, "i"), `046 migration missing ${col}`);
  }

  for (const idx of [
    "spx_booking_history_team_vehicle_idx",
    "spx_booking_history_team_created_id_idx",
    "aah_team_id_idx",
    "aah_team_trace_idx",
    "notification_deliveries_started_outbox_idx",
  ]) {
    assert.match(migrationSql, new RegExp(`\\b${idx}\\b`, "i"), `046 migration missing composite index ${idx}`);
    assert.match(verifierSource, new RegExp(`\\b${idx}\\b`), `schema-verify.mjs missing composite index ${idx}`);
  }
}

async function main(): Promise<void> {
  await testTeamRuntimeNonBlockingAccountRefresh();
  testBookingHistoryNoRedundantSelectBeforeInsertIgnore();
  testDbResetProductionGuard();
  await testPruneNonReplayableRealtimeEvents();
  testMigration046AndSchemaVerifierAlignment();
  await closePool();
  console.log("task5-hotpath-and-db: all assertions passed");
}

main().catch(async (error) => {
  await closePool().catch(() => {});
  console.error(error);
  process.exit(1);
});
