import assert from "node:assert/strict";
import Fastify from "fastify";
import { dashboardController } from "../src/controllers/dashboard-controller.js";
import { reportController } from "../src/controllers/report-controller.js";
import { TeamRuntime } from "../src/services/team-runtime.js";
import { Poller } from "../src/controllers/poller.js";
import { ApiClient } from "../src/services/api-client.js";
import { MetricsCollector, teamMetricsCollector } from "../src/services/metrics.js";
import { env } from "../src/config/env.js";
import { runtimeMetricsSnapshotFor } from "../src/services/runtime-metrics.js";
import { publishRuntimeMetricsSnapshot } from "../src/services/runtime-metrics-client.js";
import { internalNotificationController } from "../src/controllers/internal-notification-controller.js";
import { createRealtimeEnvelope } from "../src/services/realtime-contract.js";
import {
  projectRealtimeMetricsEnvelope,
  getRealtimeMetricsReadModelByTeamId,
} from "../src/repositories/realtime-metrics-read-model-repository.js";
import { closePool } from "../src/db/client.js";
type Inner = {
  apiClient: ApiClient;
  metrics: MetricsCollector;
  teamId: number;
  beforePoll: undefined;
  tick(): Promise<void>;
  metricsSnapshot(): ReturnType<MetricsCollector["snapshot"]>;
  processOneBooking(): Promise<boolean>;
  detailLaunchDelay(): Promise<void>;
};
async function main() {
  const originalStart = Poller.prototype.start;
  const originalFetch = globalThis.fetch;
  const saved = { ...env };
  const pollers: Inner[] = [];
  const detailAt = new Map<number, number>();
  const publishedAt = new Map<number, number>();
  Object.assign(env, {
    SPX_ROLE: "monolith",
    FETCH_DETAILS: true,
    AUTO_ACCEPT_ENABLED: false,
    SAVE_TO_DB: false,
    HTTP_ENABLED: false,
    API_URL: "https://provider.example.test/booking/bidding/list",
    BOOKING_DETAIL_CONCURRENCY: 4,
    BOOKING_REPROCESS_COOLDOWN_MS: 0,
  });
  Poller.prototype.start = async function () {
    const inner = this as unknown as Inner;
    inner.beforePoll = undefined;
    const fetchDetails = inner.apiClient.fetchBookingRequestList.bind(inner.apiClient);
    inner.apiClient.fetchBookingRequestList = async (...args) => {
      if (!detailAt.has(inner.teamId)) detailAt.set(inner.teamId, Date.now());
      return fetchDetails(...args);
    };
    inner.detailLaunchDelay = async () => {};
    pollers.push(inner);
  };
  const published: unknown[] = [];
  const runtimes = [1, 2].map(
    (id) =>
      new TeamRuntime(
        {
          id,
          name: `Synthetic ${id}`,
          enabled: true,
          spxCookie: `synthetic-${id}`,
          spxDeviceId: "synthetic",
          lineGroupId: "",
          autoAcceptSuccessLineGroupId: "",
          autoAcceptFailureLineGroupId: "",
          rateLimitNotifyEnabled: false,
          biddingVehicleType: null,
        },
        {
          realtimePublisher: {
            publish: async (input: Parameters<typeof createRealtimeEnvelope>[0]) => {
              published.push(input);
              if (input.scope.kind === "team") publishedAt.set(input.scope.teamId, Date.now());
              await projectRealtimeMetricsEnvelope(createRealtimeEnvelope(input));
              return { accepted: true };
            },
          } as never,
        },
      ),
  );
  const app = Fastify({ logger: false });
  let authUser = { id: 101, username: "synthetic", role: "user", teamId: 1 as number | null };
  app.decorateRequest("jwtVerify", async () => authUser);
  app.addHook("preHandler", async (req) => {
    req.user = authUser as never;
  });
  const controlSnapshots: Array<ReturnType<MetricsCollector["snapshot"]>> = [];
  try {
    await app.register(internalNotificationController, {
      prefix: "/internal",
      sharedSecret: "synthetic-secret",
      allowedNodes: new Map([["synthetic-worker", new Set([1, 2])]]),
    });
    await app.register(dashboardController, {
      realtimePublisher: {
        publish: async (input: { payload: ReturnType<MetricsCollector["snapshot"]> }) => {
          controlSnapshots.push(input.payload);
          return { accepted: true };
        },
      } as never,
    });
    await app.register(reportController, { prefix: "/reports" });
    await app.ready();
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    assert.equal(pollers.length, 2);
    for (const p of pollers)
      assert.equal(
        p.metrics,
        p.apiClient.metricsCollector,
        "runtime shares exact collector with API and poller",
      );
    globalThis.fetch = async (_url, init) => {
      if (String(_url).includes("/request/list"))
        return Response.json({
          retcode: 0,
          message: "",
          data: { pageno: 1, count: 0, total: 0, request_list: [] },
        });
      const page = JSON.parse(String(init?.body)).pageno;
      await new Promise((resolve) => setTimeout(resolve, page === 1 ? 15 : 50));
      return Response.json({
        retcode: 0,
        message: "",
        data: {
          pageno: page,
          count: 1,
          total: 2,
          list: [{ booking_id: page, booking_name: "[ADHOC] synthetic" }],
        },
      });
    };
    pollers[0].metrics.recordOperation("firstMatchToAcceptStart", 100);
    pollers[0].metrics.recordOperation("firstMatchToAcceptStart", 200);
    pollers[1].metrics.recordOperation("firstMatchToAcceptStart", 600);
    await Promise.all(pollers.map((p) => p.tick()));
    for (const p of pollers) {
      const local = runtimeMetricsSnapshotFor(new MetricsCollector().snapshot(), p.teamId);
      assert.equal(local.operations.biddingListPage1.count, 1);
      assert.equal(
        local.operations.page1ToDetailStart.count,
        1,
        "later-page detail must not fabricate first-page observation",
      );
      assert.equal(local.upstream.requests, 4);
      const durable = await getRealtimeMetricsReadModelByTeamId(p.teamId);
      assert.ok(durable);
      assert.deepEqual(
        durable.snapshot.operations.page1ToDetailStart,
        local.operations.page1ToDetailStart,
      );
      assert.deepEqual(
        durable.snapshot.operations.firstMatchToAcceptStart,
        local.operations.firstMatchToAcceptStart,
      );
      const result = await publishRuntimeMetricsSnapshot({
        url: "https://internal.example.test/internal/runtime-metrics",
        sharedSecret: "synthetic-secret",
        nodeId: "synthetic-worker",
        snapshot: local,
        fetchImpl: async (_url, init) => {
          const res = await app.inject({
            method: "POST",
            url: "/internal/runtime-metrics",
            headers: Object.fromEntries(new Headers(init.headers)),
            payload: String(init.body),
          });
          return new Response(res.body, { status: res.statusCode });
        },
      });
      assert.equal(result.ok, true);
    }
    assert.equal(published.length, 2);
    for (const p of pollers) {
      const avoidedWait = publishedAt.get(p.teamId)! - detailAt.get(p.teamId)!;
      assert.ok(
        avoidedWait >= 40,
        "synthetic gated extra page no longer holds first-page detail start",
      );
      console.log(
        JSON.stringify({
          scenario: "synthetic extra-page wait",
          teamId: p.teamId,
          firstPageDetailStartedBeforeFullListMs: avoidedWait,
          productionClaim: false,
        }),
      );
    }
    const all = runtimeMetricsSnapshotFor(new MetricsCollector().snapshot(), null);
    assert.equal(all.operations.firstMatchToAcceptStart.count, 3);
    assert.equal(all.operations.firstMatchToAcceptStart.avg, 300);
    assert.equal(teamMetricsCollector(1).snapshot().operations.firstMatchToAcceptStart.avg, 150);
    assert.equal(teamMetricsCollector(2).snapshot().operations.firstMatchToAcceptStart.avg, 600);
    for (const teamId of [1, 2]) {
      authUser = { ...authUser, role: "user", teamId };
      const response = await app.inject({ method: "GET", url: "/metrics" });
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.json().data.operations.firstMatchToAcceptStart.avg,
        teamId === 1 ? 150 : 600,
      );
      const csv = await app.inject({ method: "GET", url: "/reports/metrics.csv" });
      assert.equal(csv.statusCode, 200);
      assert.ok(csv.body.includes("totalRequests,1"), csv.body);
    }
    authUser = { ...authUser, role: "admin", teamId: null };
    const adminResponse = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(adminResponse.json().data.operations.firstMatchToAcceptStart.avg, 300);
    const adminCsv = await app.inject({ method: "GET", url: "/reports/metrics.csv" });
    assert.equal(adminCsv.statusCode, 200);
    assert.ok(adminCsv.body.includes("totalRequests,2"), adminCsv.body);
    for (const endpoint of ["/system/pause?teamId=2", "/system/resume?teamId=2"])
      assert.equal((await app.inject({ method: "POST", url: endpoint })).statusCode, 200);
    assert.deepEqual(
      controlSnapshots.map((snapshot) => snapshot.isPaused),
      [true, false],
    );
    assert.ok(
      controlSnapshots.every((snapshot) => snapshot.operations.firstMatchToAcceptStart.avg === 600),
      "control publisher preserves owning team samples",
    );
    console.log(
      "team-runtime-stage-metrics: concurrent real API→Poller→canonical publisher→durable consumer and signed remote ingestion passed; local/admin reads isolated",
    );
  } finally {
    Poller.prototype.start = originalStart;
    await Promise.all(runtimes.map((r) => r.stop()));
    globalThis.fetch = originalFetch;
    Object.assign(env, saved);
    await app.close();
    await closePool();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
