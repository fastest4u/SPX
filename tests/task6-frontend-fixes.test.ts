import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MetricsHistoryRow } from "../src/frontend/types/index.js";

const redirects: string[] = [];
(globalThis as unknown as { window: unknown }).window = {
  location: {
    origin: "http://localhost",
    replace(url: string) {
      redirects.push(url);
    },
  },
};

async function testSingleFlightSilentRefresh(): Promise<void> {
  let refreshCalls = 0;
  const seenCounts = new Map<string, number>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const count = (seenCounts.get(url) ?? 0) + 1;
    seenCounts.set(url, count);

    if (url.endsWith("/refresh")) {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return new Response(JSON.stringify({ status: "success", data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // First attempt on each protected endpoint returns 401 simultaneously
    if (count === 1) {
      return new Response(
        JSON.stringify({ status: "error", error_code: "UNAUTHORIZED", message: "expired" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/rules")) {
      return new Response(JSON.stringify({ status: "success", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/teams")) {
      return new Response(JSON.stringify({ status: "success", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/settings")) {
      return new Response(
        JSON.stringify({ status: "success", data: { values: { APP_NAME: "SPX" }, reloadBehavior: {} } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ status: "success", data: { uptime: 99 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const { rulesApi, teamsApi, settingsApi, metricsApi } = await import("../src/frontend/lib/api.js");
  const [rules, teams, settings, snapshot] = await Promise.all([
    rulesApi.list(),
    teamsApi.list(),
    settingsApi.get(),
    metricsApi.snapshot(),
  ]);

  assert.equal(
    refreshCalls,
    1,
    `Concurrent 401 responses must share 1 single-flight /refresh call, got ${refreshCalls}`,
  );
  assert.deepEqual(redirects, []);
  assert.deepEqual(rules, []);
  assert.deepEqual(teams, []);
  assert.deepEqual(settings, { APP_NAME: "SPX" });
  assert.deepEqual(snapshot, { uptime: 99 });
}

async function testSseTeamScopingAndEventWiring(): Promise<void> {
  const sseEventsMod = (await import("../src/frontend/lib/dashboard-sse-events.js")) as Record<
    string,
    unknown
  >;
  assert.equal(
    typeof sseEventsMod.matchesExpectedSseTeam,
    "function",
    "Expected matchesExpectedSseTeam helper in dashboard-sse-events.ts",
  );
  const matchesExpectedSseTeam = sseEventsMod.matchesExpectedSseTeam as (
    raw: string,
    expectedTeamId?: number | null,
  ) => boolean;

  const canonicalTeam2Rules = JSON.stringify({
    envelopeVersion: 1,
    type: "rules.changed",
    scope: { kind: "team", teamId: 2 },
    payload: [],
  });
  const legacyTeam2Rules = JSON.stringify({
    teamId: 2,
    event: "rules",
    data: [],
  });

  assert.equal(matchesExpectedSseTeam(canonicalTeam2Rules, 2), true);
  assert.equal(matchesExpectedSseTeam(canonicalTeam2Rules, 1), false);
  assert.equal(matchesExpectedSseTeam(canonicalTeam2Rules, null), true);
  assert.equal(matchesExpectedSseTeam(legacyTeam2Rules, 2), true);
  assert.equal(matchesExpectedSseTeam(legacyTeam2Rules, 1), false);
  assert.equal(matchesExpectedSseTeam(legacyTeam2Rules, null), true);

  const useSseSource = readFileSync(resolve(process.cwd(), "src/frontend/hooks/useSse.ts"), "utf8");
  assert.match(
    useSseSource,
    /registerDashboardSseListeners/,
    "useSse.ts must register canonical + legacy listeners via registerDashboardSseListeners",
  );
  assert.match(
    useSseSource,
    /matchesExpectedSseTeam/,
    "useSse.ts must filter team-scoped rules/session events via matchesExpectedSseTeam",
  );
  assert.match(
    useSseSource,
    /addEventListener\(\s*['"]online['"]/,
    "useSse.ts must listen for browser online events to recover after retry exhaustion",
  );
  assert.match(
    useSseSource,
    /addEventListener\(\s*['"]visibilitychange['"]/,
    "useSse.ts must listen for document visibilitychange events to recover when tab becomes visible",
  );
}

async function testReportsAndRouterErrorBoundary(): Promise<void> {
  const reportsMod = (await import("../src/frontend/routes/reports.js")) as Record<string, unknown>;
  assert.equal(
    typeof reportsMod.selectLatestMetricsHistoryRow,
    "function",
    "Expected selectLatestMetricsHistoryRow helper in reports.tsx",
  );
  assert.equal(
    typeof reportsMod.isAuditReportVisibleForRole,
    "function",
    "Expected isAuditReportVisibleForRole helper in reports.tsx",
  );

  const selectLatest = reportsMod.selectLatestMetricsHistoryRow as (
    rows: readonly MetricsHistoryRow[],
  ) => MetricsHistoryRow | null;
  const isAuditVisible = reportsMod.isAuditReportVisibleForRole as (
    role?: string | null,
  ) => boolean;

  // getRecentMetricsSnapshots returns DESC order (rows[0] is newest, rows[last] is oldest)
  const descRows: MetricsHistoryRow[] = [
    {
      id: 2,
      createdAt: "2026-11-11T12:00:00.000Z",
      uptime: 7200,
      requestCount: 100,
      successCount: 99,
      errorCount: 1,
      successRate: 99.5,
      latencyAvg: 40,
      latencyP95: 80,
      latencyP99: 110,
      recordsSeen: 500,
      changesDetected: 10,
      tripsInserted: 10,
      tripsSkipped: 490,
    },
    {
      id: 1,
      createdAt: "2026-11-11T04:00:00.000Z",
      uptime: 3600,
      requestCount: 50,
      successCount: 35,
      errorCount: 15,
      successRate: 70.0,
      latencyAvg: 120,
      latencyP95: 250,
      latencyP99: 400,
      recordsSeen: 200,
      changesDetected: 4,
      tripsInserted: 4,
      tripsSkipped: 196,
    },
  ];

  assert.equal(selectLatest(descRows)?.successRate, 99.5, "Must pick newest snapshot (99.5%), not oldest (70.0%)");
  assert.equal(selectLatest([]), null);
  assert.equal(isAuditVisible("admin"), true);
  assert.equal(isAuditVisible("user"), false);
  assert.equal(isAuditVisible(null), false);

  const reportsSource = readFileSync(resolve(process.cwd(), "src/frontend/routes/reports.tsx"), "utf8");
  assert.match(
    reportsSource,
    /refetchInterval:\s*(?:60\s*\*\s*1000|60_000|60000)/,
    "reports.tsx must auto-refresh metrics history every 60 seconds as promised in UI subtitle",
  );

  const mainSource = readFileSync(resolve(process.cwd(), "src/frontend/main.tsx"), "utf8");
  assert.match(
    mainSource,
    /defaultErrorComponent/,
    "main.tsx must configure defaultErrorComponent on TanStack Router",
  );
}

async function main(): Promise<void> {
  await testSingleFlightSilentRefresh();
  await testSseTeamScopingAndEventWiring();
  await testReportsAndRouterErrorBoundary();
  console.log("task6-frontend-fixes: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
