import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import type { RuntimeMetricsRecord } from "../src/services/runtime-metrics.js";

async function main() {
  const savedUrl = process.env.API_URL;
  // Dispatcher ownership captures the configured host at module initialization.
  // Set the synthetic boundary before importing any backend dependencies.
  process.env.API_URL = "https://synthetic-provider.test/booking/bidding/list";
  const { ApiClient } = await import("../src/services/api-client.js");
  const { MetricsCollector } = await import("../src/services/metrics.js");
  const { mergeConnectionPools, normalizeRuntimeMetricsSnapshot, runtimeMetricsSummaryReadModelFromRecords } = await import("../src/services/runtime-metrics.js");
  const savedFetch = globalThis.fetch;
  const one = new MetricsCollector({ teamId: 81 });
  const two = new MetricsCollector({ teamId: 82 });
  const clients = [one, two].map(metricsCollector => new ApiClient({ metricsCollector }));
  globalThis.fetch = async () => Response.json({ retcode: 0, message: "", data: { pageno: 1, count: 0, total: 0, request_list: [] } });
  try {
    for (let i = 0; i < 10; i++) diagnosticsChannel.channel("undici:client:connected").publish({ connectParams: { hostname: "synthetic-provider.test" } });
    for (let i = 0; i < 100; i++) await clients[0].fetchBookingRequestList(i);
    const earlier = one.snapshot();
    for (let i = 0; i < 100; i++) await clients[1].fetchBookingRequestList(i);
    const later = two.snapshot();
    const records = [earlier, later].map(snapshot => ({ teamId: snapshot.teamId!, nodeId: "same-process", snapshot: normalizeRuntimeMetricsSnapshot(snapshot), emittedAt: Date.now(), receivedAt: Date.now(), updatedAt: Date.now() }));
    const aggregate = (rows: RuntimeMetricsRecord[]) => runtimeMetricsSummaryReadModelFromRecords(one.snapshot(), rows, null, { expectedTeamIds: [81, 82], now: Date.now() }).metrics;
    const admin = aggregate(records);
    assert.equal(admin.upstream.requests, 200);
    assert.equal(admin.upstream.connections, 10, "shared physical pool must be counted once");
    assert.equal(admin.upstream.reuseRatio, 95);
    assert.equal(admin.upstream.connectionScope, "aggregate");
    assert.equal(earlier.upstream.connectionScope, "process");
    assert.equal(earlier.upstream.connectionPools![0].id, later.upstream.connectionPools![0].id);
    assert.equal(earlier.upstream.connectionPools![0].requests, 100);
    assert.equal(later.upstream.connectionPools![0].requests, 200);
    assert.deepEqual(aggregate([...records].reverse()).upstream, admin.upstream, "publication order cannot rewind process counters");
    const replacement = new MetricsCollector({ teamId: 81 }).snapshot();
    assert.equal(replacement.upstream.requests, 0);
    assert.deepEqual(replacement.upstream.connectionPools, later.upstream.connectionPools, "new team collector cannot reset a process observation under the same ID");
    const otherProcess = structuredClone(records[1]);
    otherProcess.snapshot.upstream.connectionPools![0] = { id: "synthetic-other-process", requests: 100, connections: 10 };
    assert.equal(aggregate([records[0], otherProcess]).upstream.connections, 20, "distinct process pools remain distinct");
    const legacy = structuredClone(earlier);
    delete legacy.upstream.connectionPools;
    delete legacy.upstream.connectionScope;
    assert.equal(normalizeRuntimeMetricsSnapshot(legacy).upstream.requests, 100);
    const mixed = aggregate([{ ...records[0], snapshot: legacy }, records[1]]);
    assert.equal(mixed.upstream.connectionScope, "unknown", "legacy ownership cannot support complete reuse claims");
    const pools = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      requests: index + 1,
      connections: 1,
    }));
    const first128 = pools("first", 128);
    const secondWithDuplicate = [{ id: "first-0", requests: 500, connections: 4 }, ...pools("second", 128)];
    const atLimit = mergeConnectionPools([
      { ...earlier.upstream, connectionScope: "aggregate", connectionPools: first128 },
      { ...later.upstream, connectionScope: "aggregate", connectionPools: secondWithDuplicate },
    ]);
    assert.equal(atLimit.connectionScope, "aggregate", "256 unique pools retain complete ownership");
    assert.equal(atLimit.connectionPools.length, 256);
    assert.deepEqual(atLimit.connectionPools.find(pool => pool.id === "first-0"), { id: "first-0", requests: 500, connections: 4 }, "duplicate pool IDs retain cumulative maxima");
    assert.equal(normalizeRuntimeMetricsSnapshot({
      ...earlier,
      upstream: { ...earlier.upstream, ...atLimit },
    }).upstream.connectionScope, "aggregate", "the exact-limit merge must cross the wire normalizer");

    const overflow = mergeConnectionPools([
      { ...earlier.upstream, connectionScope: "aggregate", connectionPools: first128 },
      { ...later.upstream, connectionScope: "aggregate", connectionPools: pools("overflow", 129) },
    ]);
    assert.equal(overflow.connectionScope, "unknown", "257 unique pools must expose incomplete ownership");
    assert.equal(overflow.connectionPools.length, 256, "exported merge output must remain within the wire limit");
    const normalizedOverflow = normalizeRuntimeMetricsSnapshot({
      ...earlier,
      upstream: { ...earlier.upstream, ...overflow },
    });
    assert.equal(normalizedOverflow.upstream.connectionScope, "unknown", "bounded overflow must cross the wire normalizer without a complete reuse claim");
    assert.deepEqual(normalizedOverflow.polling, earlier.polling, "pool overflow must not discard unrelated metrics");
    const overflowRecords = [
      { ...records[0], snapshot: normalizeRuntimeMetricsSnapshot({ ...earlier, upstream: { ...earlier.upstream, requests: 1_000, connectionScope: "aggregate", connectionPools: first128 } }) },
      { ...records[1], snapshot: normalizeRuntimeMetricsSnapshot({ ...later, upstream: { ...later.upstream, requests: 2_000, connectionScope: "aggregate", connectionPools: pools("overflow", 129) } }) },
    ];
    const overflowAdmin = aggregate(overflowRecords);
    assert.equal(overflowAdmin.upstream.requests, 3_000, "pool overflow must preserve team request totals");
    assert.equal(overflowAdmin.upstream.connections, 256, "unknown ownership reports only the bounded known pool subset");
    assert.equal(overflowAdmin.upstream.reuseRatio, 0, "incomplete pool ownership cannot present a complete reuse total");
    assert.equal(overflowAdmin.upstream.connectionScope, "unknown");
    assert.equal(overflowAdmin.upstream.connectionPools?.length, 256);

    const unknown = mergeConnectionPools([
      { ...earlier.upstream, connectionScope: "unknown", connectionPools: first128 },
      { ...later.upstream, connectionScope: "aggregate", connectionPools: secondWithDuplicate },
    ]);
    assert.equal(unknown.connectionScope, "unknown", "unknown input ownership remains unknown after a bounded merge");
    assert.equal(unknown.connectionPools.length, 256);
    normalizeRuntimeMetricsSnapshot({ ...earlier, upstream: { ...earlier.upstream, ...unknown } });
    for (const pool of [{ id: "", requests: 1, connections: 1 }, { id: "x", requests: -1, connections: 1 }, { id: "x", requests: Infinity, connections: 1 }, { id: "x", requests: 1, connections: 0.5 }]) {
      assert.throws(() => normalizeRuntimeMetricsSnapshot({ ...earlier, upstream: { ...earlier.upstream, connectionPools: [pool] } }));
    }
    assert.throws(() => normalizeRuntimeMetricsSnapshot({ ...earlier, upstream: { ...earlier.upstream, connectionPools: Array.from({ length: 257 }, (_, i) => ({ id: String(i), requests: 0, connections: 0 })) } }));
    console.log("runtime-metrics-pool-ownership: two real team API producers, bounded 256/257 pool merges, duplicate maxima, unknown ownership and metadata validation passed");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = savedUrl;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
