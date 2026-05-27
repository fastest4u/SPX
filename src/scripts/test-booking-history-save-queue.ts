import assert from "node:assert/strict";
import { BookingHistorySaveQueue } from "../services/booking-history-save-queue.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";

function trip(requestId: number): ExtractedTripInfo {
  return { request_id: requestId } as ExtractedTripInfo;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function testSerializesSaves(): Promise<void> {
  const firstSave = createDeferred<{ inserted: number; skipped: number; errors: number; message: string }>();
  const savedBatches: number[][] = [];
  const results: Array<{ inserted: number; skipped: number; errors: number; message: string }> = [];

  const queue = new BookingHistorySaveQueue({
    save: async (trips) => {
      savedBatches.push(trips.map((item) => item.request_id));
      if (savedBatches.length === 1) {
        return firstSave.promise;
      }
      return { inserted: trips.length, skipped: 0, errors: 0, message: "ok" };
    },
    onResult: (result) => {
      results.push(result);
    },
  });

  queue.enqueue([trip(1)]);
  queue.enqueue([trip(2), trip(3)]);

  await Promise.resolve();

  assert.deepEqual(savedBatches, [[1]]);
  assert.equal(queue.pendingCount, 2);
  assert.equal(queue.isSaving, true);

  firstSave.resolve({ inserted: 1, skipped: 0, errors: 0, message: "ok" });
  await queue.flush();

  assert.deepEqual(savedBatches, [[1], [2, 3]]);
  assert.deepEqual(results.map((result) => result.inserted), [1, 2]);
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.isSaving, false);

}

async function testCoalescesPendingTripsByRequestId(): Promise<void> {
  const firstSave = createDeferred<{ inserted: number; skipped: number; errors: number; message: string }>();
  const savedBatches: number[][] = [];

  const queue = new BookingHistorySaveQueue({
    save: async (trips) => {
      savedBatches.push(trips.map((item) => item.request_id));
      if (savedBatches.length === 1) {
        return firstSave.promise;
      }
      return { inserted: trips.length, skipped: 0, errors: 0, message: "ok" };
    },
  });

  queue.enqueue([trip(10)]);
  queue.enqueue([trip(20), trip(20)]);
  queue.enqueue([trip(20), trip(30)]);

  await Promise.resolve();

  assert.deepEqual(savedBatches, [[10]]);
  assert.equal(queue.pendingCount, 2);

  firstSave.resolve({ inserted: 1, skipped: 0, errors: 0, message: "ok" });
  await queue.flush();

  assert.deepEqual(savedBatches, [[10], [20, 30]]);
}

async function testBoundsPendingTrips(): Promise<void> {
  const firstSave = createDeferred<{ inserted: number; skipped: number; errors: number; message: string }>();
  const savedBatches: number[][] = [];
  const droppedBatches: number[][] = [];

  const queue = new BookingHistorySaveQueue({
    maxPendingTrips: 2,
    save: async (trips) => {
      savedBatches.push(trips.map((item) => item.request_id));
      if (savedBatches.length === 1) {
        return firstSave.promise;
      }
      return { inserted: trips.length, skipped: 0, errors: 0, message: "ok" };
    },
    onDrop: (trips) => {
      droppedBatches.push(trips.map((item) => item.request_id));
    },
  });

  queue.enqueue([trip(100)]);
  queue.enqueue([trip(200)]);
  queue.enqueue([trip(300)]);
  queue.enqueue([trip(400)]);

  await Promise.resolve();

  assert.deepEqual(savedBatches, [[100]]);
  assert.deepEqual(droppedBatches, [[200]]);
  assert.equal(queue.pendingCount, 2);

  firstSave.resolve({ inserted: 1, skipped: 0, errors: 0, message: "ok" });
  await queue.flush();

  assert.deepEqual(savedBatches, [[100], [300, 400]]);
}

async function runTests(): Promise<void> {
  await testSerializesSaves();
  await testCoalescesPendingTripsByRequestId();
  await testBoundsPendingTrips();

  console.log("Booking history save queue tests passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
