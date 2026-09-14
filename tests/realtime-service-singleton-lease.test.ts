import assert from "node:assert/strict";
import {
  acquireRealtimeServiceSingletonLease,
  type RealtimeSingletonConnection,
} from "../src/services/realtime-service-singleton-lease.js";

type QueryResult = [Array<Record<string, unknown>>, unknown];

class FakeConnection implements RealtimeSingletonConnection {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  released = 0;
  errorListener: ((error: Error) => void) | null = null;
  results: QueryResult[] = [];
  queryError: Error | null = null;

  async query(sql: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push({ sql, values });
    if (this.queryError) throw this.queryError;
    const next = this.results.shift();
    if (!next) throw new Error("unexpected query");
    return next;
  }

  release(): void {
    this.released += 1;
  }

  on(event: "error", listener: (error: Error) => void): void {
    assert.equal(event, "error");
    this.errorListener = listener;
  }

  off(event: "error", listener: (error: Error) => void): void {
    assert.equal(event, "error");
    if (this.errorListener === listener) this.errorListener = null;
  }
}

async function main(): Promise<void> {
  let memoryConnections = 0;
  const memory = await acquireRealtimeServiceSingletonLease({
    dbMode: "memory",
    getConnection: async () => {
      memoryConnections += 1;
      return new FakeConnection();
    },
  });
  await memory.release();
  await memory.release();
  assert.equal(memoryConnections, 0);

  const unavailableConnection = new FakeConnection();
  unavailableConnection.results.push([[{ acquired: 0 }], undefined]);
  await assert.rejects(
    () => acquireRealtimeServiceSingletonLease({
      dbMode: "mysql",
      getConnection: async () => unavailableConnection,
    }),
    /^Error: Realtime service singleton lease unavailable$/,
  );
  assert.equal(unavailableConnection.released, 1);

  const queryFailureConnection = new FakeConnection();
  queryFailureConnection.queryError = new Error("mysql password=must-not-leak");
  await assert.rejects(
    () => acquireRealtimeServiceSingletonLease({
      dbMode: "mysql",
      getConnection: async () => queryFailureConnection,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message, "Realtime service singleton lease unavailable");
      assert.equal(String(error).includes("password"), false);
      return true;
    },
  );
  assert.equal(queryFailureConnection.released, 1);

  const callbacks: Array<() => void> = [];
  let cleared = 0;
  let leaseLost = 0;
  const ownedConnection = new FakeConnection();
  ownedConnection.results.push(
    [[{ acquired: 1 }], undefined],
    [[{ owned: 0 }], undefined],
    [[{ released: 1 }], undefined],
  );
  const owned = await acquireRealtimeServiceSingletonLease({
    dbMode: "mysql",
    getConnection: async () => ownedConnection,
    setIntervalFn: (callback) => {
      callbacks.push(callback);
      return 7 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      cleared += 1;
    },
    onLeaseLost: () => {
      leaseLost += 1;
    },
  });
  assert.equal(callbacks.length, 1);
  callbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leaseLost, 1);
  ownedConnection.errorListener?.(new Error("socket lost with secret"));
  assert.equal(leaseLost, 1, "lease loss callback must be idempotent");
  await owned.release();
  await owned.release();
  assert.equal(cleared, 1);
  assert.equal(ownedConnection.released, 1);
  assert.match(ownedConnection.calls[0].sql, /GET_LOCK/);
  assert.match(ownedConnection.calls[1].sql, /IS_USED_LOCK/);
  assert.match(ownedConnection.calls[2].sql, /RELEASE_LOCK/);
  assert.equal(ownedConnection.calls[0].values?.[0], "spx:realtime-service:singleton:v1");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
