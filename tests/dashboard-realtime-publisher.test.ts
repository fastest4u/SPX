process.env.DB_MODE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import type { MetricsSnapshot } from "../src/services/metrics.js";
import type {
  RealtimePublishInput,
  RealtimePublishResult,
  RealtimeSource,
} from "../src/services/realtime-contract.js";

const snapshot = {} as MetricsSnapshot;
const source: RealtimeSource = { service: "web-api", nodeId: "dashboard-test", role: "web-api" };

class FakePublisher {
  canonical: Array<RealtimePublishInput<MetricsSnapshot>> = [];
  legacy: Array<{ event: string; teamId: number; data: MetricsSnapshot }> = [];
  order: string[] = [];

  async publish(envelope: RealtimePublishInput<MetricsSnapshot>): Promise<RealtimePublishResult> {
    this.canonical.push(envelope);
    this.order.push("canonical");
    return {
      accepted: true,
      duplicate: false,
      id: "dashboard-test-event",
      receivedAt: "2026-07-10T00:00:00.000Z",
      persisted: false,
    };
  }

  async publishLegacy(event: { event: string; teamId: number; data: MetricsSnapshot }): Promise<void> {
    this.legacy.push(event);
    this.order.push("legacy");
  }
}

test("publishes a team-scoped canonical metrics snapshot before its legacy SSE event", async () => {
  const { publishDashboardMetricsSnapshot } = await import("../src/controllers/dashboard-controller.js");
  const publisher = new FakePublisher();

  await publishDashboardMetricsSnapshot(2, snapshot, {
    publisher: publisher as never,
    source,
  });

  assert.equal(publisher.canonical[0]?.type, "metrics.snapshot");
  assert.equal(publisher.canonical[0]?.payloadVersion, 1);
  assert.deepEqual(publisher.canonical[0]?.scope, { kind: "team", teamId: 2 });
  assert.deepEqual(publisher.canonical[0]?.subject, { type: "team", id: "2", teamId: 2 });
  assert.deepEqual(publisher.canonical[0]?.source, source);
  assert.equal(publisher.canonical[0]?.replayable, false);
  assert.deepEqual(publisher.legacy, [{ event: "metrics", teamId: 2, data: snapshot }]);
  assert.deepEqual(publisher.order, ["canonical", "legacy"]);
});

test("swallows canonical publisher failures without emitting a legacy SSE event", async () => {
  const { publishDashboardMetricsSnapshot } = await import("../src/controllers/dashboard-controller.js");
  const publisher = new FakePublisher();
  publisher.publish = async () => {
    throw new Error("publisher unavailable");
  };

  await assert.doesNotReject(
    publishDashboardMetricsSnapshot(2, snapshot, {
      publisher: publisher as never,
      source,
    }),
  );

  assert.deepEqual(publisher.legacy, []);
});

test("pause and resume return success when their injected realtime publisher fails", async () => {
  const Fastify = (await import("fastify")).default;
  const { dashboardController } = await import("../src/controllers/dashboard-controller.js");
  const { closePool } = await import("../src/db/client.js");
  const publisher = new FakePublisher();
  let attempts = 0;
  publisher.publish = async () => {
    attempts += 1;
    throw new Error("publisher unavailable");
  };

  const app = Fastify({ logger: false });
  app.decorateRequest("jwtVerify", async () => ({
    id: 101,
    username: "dashboard-test",
    role: "user",
    teamId: 2,
  }));

  try {
    await app.register(dashboardController, {
      realtimePublisher: publisher as never,
      realtimeSource: source,
    });

    for (const endpoint of ["/system/pause", "/system/resume"]) {
      const response = await app.inject({ method: "POST", url: endpoint });
      assert.equal(response.statusCode, 200);
    }

    assert.equal(attempts, 2);
  } finally {
    await app.close();
    await closePool();
  }
});
