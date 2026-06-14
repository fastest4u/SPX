import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookingHistorySaveQueue } from "../src/services/booking-history-save-queue.js";
import type { ExtractedTripInfo } from "../src/utils/booking-extractor.js";

function trip(requestId: number): ExtractedTripInfo {
  return { request_id: requestId } as ExtractedTripInfo;
}

async function testChunksLargeBatches(): Promise<void> {
  const savedBatches: number[][] = [];
  const queue = new BookingHistorySaveQueue({
    maxBatchSize: 2,
    save: async (trips) => {
      savedBatches.push(trips.map((item) => item.request_id));
      return { inserted: trips.length, skipped: 0, errors: 0, message: "ok" };
    },
  });

  queue.enqueue([trip(1), trip(2), trip(3)]);
  await queue.flush();

  assert.deepEqual(savedBatches, [[1, 2], [3]]);
}

async function testDeadLettersFailedBatch(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "spx-history-queue-test-"));
  const deadLetterPath = join(tempDir, "dead-letter.jsonl");
  const failedTrips = [trip(10), trip(11)];
  let errors = 0;
  const queue = new BookingHistorySaveQueue({
    deadLetterPath,
    save: async () => {
      throw new Error("database unavailable");
    },
    onError: () => {
      errors += 1;
    },
  });

  try {
    queue.enqueue(failedTrips);
    await queue.flush();

    assert.equal(errors, 1);
    assert.equal(queue.pendingCount, 0);
    const lines = (await readFile(deadLetterPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]) as { trips: Array<{ request_id: number }>; error: string };
    assert.deepEqual(entry.trips.map((item) => item.request_id), [10, 11]);
    assert.match(entry.error, /database unavailable/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testChunksLargeBatches();
  await testDeadLettersFailedBatch();
  console.log("booking-history-save-queue: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
