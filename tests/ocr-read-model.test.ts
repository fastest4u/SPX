import assert from "node:assert/strict";
import type { ServiceHealthSnapshot } from "../src/services/service-health.js";
import { buildOcrReadModel } from "../src/services/ocr-read-model.js";

function healthSnapshot(input: Partial<ServiceHealthSnapshot> & Pick<ServiceHealthSnapshot, "service" | "role">): ServiceHealthSnapshot {
  return {
    service: input.service,
    role: input.role,
    nodeId: input.nodeId ?? "node-1",
    state: input.state ?? "ok",
    checkedAt: input.checkedAt ?? "2026-07-08T00:00:00.000Z",
    details: input.details ?? {},
  };
}

async function testBuildOcrReadModel(): Promise<void> {
  const model = buildOcrReadModel({
    generatedAt: "2026-07-08T12:34:56.000Z",
    completedExtractions: 17,
    lastCompletedAt: new Date("2026-07-08T10:20:30.000Z"),
    serviceHealth: [
      healthSnapshot({
        service: "line-service",
        role: "line-service",
        details: {
          imagePath: "data/line-images/private/a.jpg",
          rawText: "do not expose this text",
        },
      }),
      healthSnapshot({
        service: "ocr-service",
        role: "ocr-service",
        details: {
          notes: [
            {
              imagePath: "data/line-images/private/a.jpg",
              rawText: "do not expose this text",
            },
            "plain array text",
          ],
          metadata: {
            extra: {
              rawText: "also hidden",
            },
          },
          provider: "codex-cli",
        },
      }),
    ],
  });

  assert.equal(model.health?.service, "ocr-service");
  assert.equal(model.totals.completedExtractions, 17);
  assert.equal(model.lastCompletedAt, "2026-07-08T10:20:30.000Z");
  assert.equal(model.totals.succeededJobs, null);
  assert.equal(model.totals.failedJobs, null);
  assert.equal(model.totals.timedOutJobs, null);
  assert.equal(model.totals.pendingJobs, null);
  assert.equal(model.lastFailureAt, null);

  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes("data/line-images/private/a.jpg"), false);
  assert.equal(serialized.includes("do not expose this text"), false);
  assert.equal(serialized.includes("plain array text"), false);
  assert.equal(serialized.includes("also hidden"), false);
  assert.deepEqual(model.health?.details, {});
}

async function testMissingOcrHealthReturnsNull(): Promise<void> {
  const model = buildOcrReadModel({
    generatedAt: "2026-07-08T12:34:56.000Z",
    completedExtractions: 0,
    lastCompletedAt: null,
    serviceHealth: [healthSnapshot({ service: "line-service", role: "line-service" })],
  });

  assert.equal(model.health, null);
  assert.equal(model.lastCompletedAt, null);
}

async function main(): Promise<void> {
  await testBuildOcrReadModel();
  await testMissingOcrHealthReturnsNull();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
