import assert from "node:assert/strict";
import { mock } from "node:test";
import { startAutoAcceptJobRealWorkerLoop } from "../src/services/auto-accept-job-real-execution-loop.js";
import type { AutoAcceptWorkerBatchResult } from "../src/services/auto-accept-worker.js";
import type {
  RealtimePublishInput,
  RealtimePublishResult,
} from "../src/services/realtime-contract.js";
import { buildRuntimeStartupPlan } from "../src/services/runtime-startup-plan.js";
import { logger } from "../src/utils/logger.js";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const summary: AutoAcceptWorkerBatchResult = {
  claimed: 0,
  succeeded: 0,
  failed: 0,
  indeterminate: 0,
  cancelled: 0,
  retried: 0,
  deadLettered: 0,
  executorErrors: 0,
  settleFailures: 0,
  checkpointed: 0,
  checkpointFailures: 0,
};
async function main() {
  const originalWarn = logger.warn;
  const expectedWarnings: unknown[][] = [];
  logger.warn = (...args: Parameters<typeof logger.warn>) => {
    if (args[0] === "auto-accept-execution-metrics-publish-failed") expectedWarnings.push(args);
    else originalWarn.apply(logger, args);
  };
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  let batches = 0;
  const published: RealtimePublishInput[] = [];
  let release!: (result: RealtimePublishResult) => void;
  const publish = async (input: RealtimePublishInput): Promise<RealtimePublishResult> => {
    published.push(input);
    if (published.length === 1)
      return new Promise((resolve) => {
        release = resolve;
      });
    throw new Error("synthetic telemetry failure");
  };
  const options = {
    nodeId: "exec-a",
    teamIds: [101],
    batchSize: 1,
    leaseMs: 60_000,
    intervalMs: 1000,
    metricsPublication: "dedicated" as const,
    realtimePublisher: { publish, publishSnapshot: publish },
    apiClientForTeam: async () => ({
      acceptBookingRequests: async () => {
        throw new Error("unused");
      },
      fetchBookingRequestList: async () => {
        throw new Error("unused");
      },
    }),
    runBatch: async (
      input: import("../src/services/auto-accept-job-real-execution.js").RunAutoAcceptJobRealExecutionBatchInput,
    ) => {
      batches++;
      input.metricsCollector!.recordOperation("acceptRtt", 42);
      input.metricsCollector!.recordOperation("firstMatchToAcceptStart", 84);
      input.metricsCollector!.recordUpstreamRequest();
      return summary;
    },
  };
  const loop = startAutoAcceptJobRealWorkerLoop(options);
  try {
    await settle();
    mock.timers.tick(5000);
    await settle();
    assert.equal(
      published.length,
      1,
      "actual execution loop must publish scoped telemetry on its independent cadence",
    );
    assert.equal(published[0].type, "metrics.execution.snapshot");
    const firstBatchCount = batches;
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(1000);
      await settle();
    }
    assert.ok(
      batches >= firstBatchCount + 10,
      "hung telemetry cannot block subsequent business batches",
    );
    assert.equal(published.length, 1, "hung publisher must not produce overlapping publications");
    release({
      accepted: true,
      duplicate: false,
      id: "released",
      receivedAt: new Date().toISOString(),
      persisted: false,
    });
    await settle();
    mock.timers.tick(5000);
    await settle();
    assert.equal(published.length, 2, "failure is contained");
    assert.deepEqual(expectedWarnings, [["auto-accept-execution-metrics-publish-failed", { error: "synthetic telemetry failure" }]]);
    const afterFailure = batches;
    mock.timers.tick(1000);
    await settle();
    assert.ok(batches > afterFailure);
    loop.stop();
    const stoppedBatches = batches;
    const stoppedPublications = published.length;
    mock.timers.tick(20_000);
    await settle();
    assert.equal(batches, stoppedBatches);
    assert.equal(published.length, stoppedPublications);
    assert.equal(await loop.runOnce(), null);
    const combined = startAutoAcceptJobRealWorkerLoop({
      ...options,
      metricsPublication: "primary-owned" as const,
    });
    try {
      mock.timers.tick(10_000);
      await settle();
      assert.equal(
        published.length,
        stoppedPublications,
        "combined collector publishes only through poller",
      );
    } finally {
      combined.stop();
    }
    for (const role of ["combined", "worker", "auto-accept-service"] as const) {
      const plan = buildRuntimeStartupPlan({
        role,
        runTeamIds: [1],
        dryRunWorkerEnabled: false,
        realWorkerEnabled: true,
        settlementWorkerEnabled: false,
      });
      assert.equal(
        plan.executionMetricsPublication,
        role === "auto-accept-service" ? "dedicated" : "primary-owned",
      );
    }
    console.log(
      "execution-metrics-loop: cadence, hang/failure isolation, stop and startup ownership passed",
    );
  } finally {
    loop.stop();
    mock.timers.reset();
    logger.warn = originalWarn;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
