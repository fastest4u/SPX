import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SseProvider } from "../src/frontend/hooks/useSseContext";
import { useScopedMetrics } from "../src/frontend/hooks/useScopedMetrics";
import { useNotificationCount } from "../src/frontend/hooks/useNotificationCount";
import { PipelineTimeline } from "../src/frontend/routes/index";
import type { AuthUser, MetricsSnapshot } from "../src/frontend/types";
import "../src/frontend/index.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let user: AuthUser = { id: 1, username: "synthetic", role: "user", teamId: 71 };
client.setQueryData(["auth"], user);
const counts: Record<string, number> = {};
let httpPaused = false;
let legacyPool = false;
function snapshot(teamId: number | null, paused = false) {
  const upstream = {
    requests: teamId === null ? 200 : 100,
    connections: 10,
    reuseRatio: 95,
    ...(!legacyPool
      ? {
          connectionScope: teamId === null ? "aggregate" : "process",
          connectionPools: [{ id: "synthetic-pool", requests: 200, connections: 10 }],
        }
      : {}),
  };
  return {
    upstream,
    teamId,
    isPaused: paused,
    uptime: 5,
    startedAt: new Date().toISOString(),
    lastPoll: {
      timestamp: new Date().toISOString(),
      latencyMs: 20,
      recordCount: 1,
      status: "same",
    },
    polling: {
      totalRequests: 1,
      successCount: 1,
      errorCount: 0,
      successRate: 100,
      latency: { avg: 20, min: 20, max: 20, p50: 20, p95: 20, p99: 20 },
    },
    session: { isHealthy: true, consecutiveErrors: 0, lastSessionWarning: null },
    database: null,
    data: { totalRecordsSeen: 1, changesDetected: 0, tripsInserted: 0, tripsSkipped: 0 },
    autoAccept: { totalAttempts: 0, successCount: 0, failureCount: 0 },
    runtime: {
      activeDetailJobs: 0,
      activeDetailBookings: 0,
      detailConcurrency: 2,
      queuedDetailBookings: 0,
      detailQueuePressure: 0,
      sseClients: 1,
    },
    operations: {
      biddingListPage1: {
        count: 1,
        avg: 42,
        min: 42,
        max: 42,
        p50: 42,
        p95: 42,
        p99: 42,
        lastMs: 42,
      },
    },
  } as MetricsSnapshot;
}
window.fetch = async (input) => {
  const path = String(input);
  if (path.includes("/auth/me")) return Response.json({ status: "success", data: user });
  if (!path.includes("/metrics")) throw new Error("Unexpected fixture request: " + path);
  const scope = user.role === "admin" ? "all" : String(user.teamId);
  counts[scope] = (counts[scope] ?? 0) + 1;
  return Response.json(snapshot(user.role === "admin" ? null : user.teamId, httpPaused));
};
class FakeEventSource {
  static current: FakeEventSource;
  handlers = new Map<string, ((event: MessageEvent) => void)[]>();
  onopen?: () => void;
  onerror?: () => void;
  constructor() {
    FakeEventSource.current = this;
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(name: string, handler: (event: MessageEvent) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  close() {}
  emit(teamId: number | null, paused: boolean, canonical = false) {
    const data = snapshot(teamId, paused);
    const payload = canonical
      ? {
          envelopeVersion: 1,
          type: "metrics.snapshot",
          scope: teamId === null ? { kind: "global" } : { kind: "team", teamId },
          payload: data,
        }
      : data;
    for (const fn of this.handlers.get(canonical ? "metrics.snapshot" : "metrics") ?? [])
      fn(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}
window.EventSource = FakeEventSource as unknown as typeof EventSource;
function View() {
  const { data, hasFreshSse } = useScopedMetrics();
  const count = useNotificationCount();
  return (
    <>
      <output aria-label="selected">
        {data ? `${data.teamId}:${data.isPaused}:${hasFreshSse}` : "none"}
      </output>
      <output aria-label="bell">{count}</output>
      <PipelineTimeline metrics={data} history={[]} />
    </>
  );
}
Object.assign(window, {
  __metricsFixture: {
    emitPayload: (data: MetricsSnapshot) => {
      for (const fn of FakeEventSource.current.handlers.get("metrics.snapshot") ?? []) {
        fn(
          new MessageEvent("message", {
            data: JSON.stringify({
              envelopeVersion: 1,
              type: "metrics.snapshot",
              scope: { kind: "team", teamId: data.teamId },
              payload: data,
            }),
          }),
        );
      }
    },
    legacyPool: (value: boolean) => {
      legacyPool = value;
    },
    emit: (teamId: number | null, paused = false, canonical = false) =>
      FakeEventSource.current.emit(teamId, paused, canonical),
    counts: () => ({ ...counts }),
    httpPaused: (value: boolean) => {
      httpPaused = value;
    },
    auth: (id: number, teamId: number | null, role: "user" | "admin" = "user") => {
      user = { id, teamId, role, username: "synthetic" };
      client.setQueryData(["auth"], user);
    },
  },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <SseProvider>
      <View />
    </SseProvider>
  </QueryClientProvider>,
);
