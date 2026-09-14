import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { createRule } from "../src/services/notify-rules.js";
import { MetricsCollector } from "../src/services/metrics.js";
import { publishAutoAcceptJob } from "../src/services/auto-accept-job-publisher.js";
import { runAutoAcceptJobRealExecutionBatch } from "../src/services/auto-accept-job-real-execution.js";
async function main() {
  try {
    for (const scenario of [
      "valid",
      "legacy",
      "negative",
      "nonfinite",
      "future",
      "shadow",
      "denied",
    ] as const) {
      await closePool();
      resetMemoryDb();
      const rule = await createRule(2, {
        name: "synthetic",
        origins: ["A"],
        destinations: ["B"],
        vehicle_types: ["4W"],
        need: 1,
        enabled: true,
        fulfilled: false,
        auto_accepted: false,
      });
      const collector = new MetricsCollector({ teamId: 2 });
      let posts = 0;
      const matchedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const firstMatchedAtMs =
        scenario === "legacy"
          ? undefined
          : scenario === "negative"
            ? -1
            : scenario === "nonfinite"
              ? NaN
              : scenario === "future"
                ? Date.now() + 60_000
                : matchedAt;
      const published = await publishAutoAcceptJob({
        teamId: 2,
        bookingId: 400,
        requestId: 401,
        ruleId: rule.id,
        ruleName: rule.name,
        executionMode: scenario === "shadow" ? "shadow" : "cutover",
        attemptKind: "pending_request",
        acceptAll: false,
        source: "pending_tab",
        pollerNodeId: "synthetic",
        firstMatchedAtMs,
        trip: {
          request_id: 401,
          booking_id: 400,
          origin: "A",
          destination: "B",
          vehicle_type: "4W",
          acceptance_status: 1,
        },
        ruleSnapshot: { need: 1, accept_all: false, enabled: true, fulfilled: false },
      });
      assert.equal(published.published, true);
      if (!published.published) throw new Error("publish failed");
      const payload = JSON.parse(published.job.payloadJson);
      assert.ok(
        Date.parse(payload.observedAt) >= matchedAt + 30,
        "publication observation retains its original later meaning",
      );
      await runAutoAcceptJobRealExecutionBatch({
        ownerNodeId: "synthetic-worker",
        teamIds: [2],
        limit: 1,
        leaseMs: 60_000,
        metricsCollector: collector,
        canStartNewExternalAttempt: () => scenario !== "denied",
        loadRuleState: async () => {
          await new Promise((resolve) => setTimeout(resolve, 35));
          return { need: 1, accept_all: false, enabled: true, fulfilled: false };
        },
        apiClient: {
          acceptBookingRequests: async () => {
            posts++;
            return { ok: true, httpStatus: 200, response: { retcode: 0 } };
          },
          fetchBookingRequestList: async () => ({
            data: {
              request_list: [{ request_id: 401, booking_id: 400, request_acceptance_status: 2 }],
            },
          }),
        },
        ambiguousRecheckDelayMs: 0,
      });
      const stage = collector.snapshot().operations.firstMatchToAcceptStart;
      if (scenario === "shadow" || scenario === "denied") {
        assert.equal(posts, 0);
        assert.equal(stage.count, 0);
      } else {
        assert.equal(posts, 1, `${scenario} timing must not block business execution`);
        assert.equal(stage.count, scenario === "valid" ? 1 : 0);
        if (scenario === "valid")
          assert.ok(
            stage.lastMs! >= 65,
            "original match metadata includes delayed publication and executor prepare",
          );
      }
    }
    console.log(
      "auto-accept-job-stage-metrics: actual publication/execute timing, legacy malformed future metadata omission and shadow/denied zero POST passed",
    );
  } finally {
    await closePool();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
