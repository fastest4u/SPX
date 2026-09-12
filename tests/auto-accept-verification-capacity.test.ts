import assert from "node:assert/strict";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import { closePool } from "../src/db/client.js";
import { createAutoAcceptVerificationIntent, updateAutoAcceptVerificationResponse } from "../src/repositories/auto-accept-verification-repository.js";
import { AutoAcceptVerificationRunner } from "../src/services/auto-accept-verification-runner.js";
import type { AutoAcceptVerificationJob } from "../src/services/auto-accept-verifier.js";
import type { ApiClient } from "../src/services/api-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Verification capacity did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function main(): Promise<void> {
  const db = getRawMemoryDb();
  const gates = new Map<number, ReturnType<typeof deferred>>();
  for (let i = 0; i < 10; i++) {
    const job: AutoAcceptVerificationJob = {
      teamId: 1, ruleId: "capacity", ruleName: "Capacity", bookingId: 991_000 + i,
      requestIds: [992_000 + i], trips: [], claimToken: 0,
      acceptResult: { ok: true, httpStatus: 200 }, acceptStartedAt: 1, acceptFinishedAt: 2,
      acceptRttMs: 1, ambiguousAccept: false, acceptAll: false, traceId: `capacity-${i}`,
    };
    gates.set(job.bookingId, deferred());
    await createAutoAcceptVerificationIntent(job);
    await updateAutoAcceptVerificationResponse(job);
  }
  let reads = 0;
  let mayRun = true;
  let restored = 0;
  const client = { fetchBookingRequestList: async (bookingId: number) => {
    reads++;
    await gates.get(bookingId)!.promise;
    return null;
  } } as unknown as ApiClient;
  const runner = new AutoAcceptVerificationRunner(1, client, {
    canRun: () => mayRun, onHold: () => { restored++; }, onSettled: () => {}, publish: async () => true,
  });
  const rowsRead: number[] = [];
  const originalPrepare = db.prepare;
  try {
    await runner.restore();
    assert.equal(restored, 10, "startup must restore every hold regardless of verification capacity");
    // Measure rows actually returned by recovery-list queries, including an
    // empty result, without changing repository or scheduler behavior.
    db.prepare = ((sql: string) => {
      const statement = originalPrepare.call(db, sql);
      if (sql.includes("ORDER BY next_attempt_at,trace_id")) {
        const originalAll = statement.all;
        statement.all = (...parameters: unknown[]) => {
          const rows = Reflect.apply(originalAll, statement, parameters) as unknown[];
          rowsRead.push(rows.length);
          return rows;
        };
      }
      return statement;
    }) as typeof db.prepare;
    await runner.runDue();
    await waitFor(() => reads === 4);
    assert.deepEqual(rowsRead, [2], "only jobs fitting the two free slots should leave the database");
    await runner.runDue();
    await runner.runDue();
    assert.deepEqual(rowsRead, [2], "a worker waiting on two provider reads must not poll the durable queue");

    gates.get(991_000)!.resolve();
    await waitFor(() => (runner as unknown as { active: Map<string, unknown> }).active.size === 1);
    await runner.runDue();
    await waitFor(() => reads === 6);
    assert.deepEqual(rowsRead, [2, 1], "one newly free slot reads one due job even with a large backlog");
  } finally {
    db.prepare = originalPrepare;
    mayRun = false;
    for (const gate of gates.values()) gate.resolve();
    await runner.stop();
    await closePool();
  }
  console.log("verification capacity: restores all holds, bounds due rows, skips database polling while full");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
