import assert from "node:assert/strict";

class LockBroker {
  private activeGlobal = 0;
  private readonly activeByName = new Map<string, number>();
  private readonly maxActiveByName = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  maxActiveGlobal = 0;

  async acquire(name: string): Promise<() => void> {
    let releaseNext!: () => void;
    const previous = this.tails.get(name) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.tails.set(name, current);
    await previous;
    this.activeGlobal += 1;
    const activeForName = (this.activeByName.get(name) ?? 0) + 1;
    this.activeByName.set(name, activeForName);
    this.maxActiveByName.set(name, Math.max(this.maxActiveByName.get(name) ?? 0, activeForName));
    this.maxActiveGlobal = Math.max(this.maxActiveGlobal, this.activeGlobal);
    let released = false;
    return () => {
      if (released) throw new Error("lock already released");
      released = true;
      this.activeGlobal -= 1;
      this.activeByName.set(name, (this.activeByName.get(name) ?? 1) - 1);
      if (this.tails.get(name) === current) this.tails.delete(name);
      releaseNext();
    };
  }

  maxActiveFor(name: string): number {
    return this.maxActiveByName.get(name) ?? 0;
  }
}

type SharedState = { rows: Set<string> };

type FakeConnectionOptions = {
  insertError?: unknown;
  lockAcquired?: number;
  releaseResult?: number;
};

class FakeMysqlConnection {
  readonly calls: string[] = [];
  readonly lockNames: string[] = [];
  private pendingInsert: string | null = null;
  private releaseLock: (() => void) | null = null;

  constructor(
    private readonly broker: LockBroker,
    private readonly state: SharedState,
    private readonly databaseName = "spx_production",
    private readonly options: FakeConnectionOptions = {},
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown]> {
    this.calls.push(sql);
    if (/SELECT DATABASE\(\)/.test(sql)) {
      return [[{ databaseName: this.databaseName }], {}];
    }
    if (/GET_LOCK/.test(sql)) {
      const lockName = String(params[0]);
      this.lockNames.push(lockName);
      if (this.options.lockAcquired === 0) return [[{ acquired: 0 }], {}];
      this.releaseLock = await this.broker.acquire(lockName);
      return [[{ acquired: 1 }], {}];
    }
    if (/RELEASE_LOCK/.test(sql)) {
      const release = this.releaseLock;
      this.releaseLock = null;
      if (!release) throw new Error("lock not held");
      release();
      return [[{ released: this.options.releaseResult ?? 1 }], {}];
    }
    if (/SELECT 1 AS active/.test(sql)) {
      return [this.state.rows.has(String(params[0])) ? [{ active: 1 }] : [], {}];
    }
    if (/^DELETE/.test(sql)) return [{ affectedRows: 0 } as never, {}];
    if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
      return [[{ total: this.state.rows.size }], {}];
    }
    if (/^INSERT/.test(sql)) {
      if (this.options.insertError) throw this.options.insertError;
      this.pendingInsert = String(params[0]);
      return [{ affectedRows: 1 } as never, {}];
    }
    throw new Error(`unexpected query shape: ${sql.split(/\s+/, 1)[0]}`);
  }

  async beginTransaction(): Promise<void> {
    this.calls.push("BEGIN");
  }

  async commit(): Promise<void> {
    this.calls.push("COMMIT");
    if (this.pendingInsert) this.state.rows.add(this.pendingInsert);
    this.pendingInsert = null;
  }

  async rollback(): Promise<void> {
    this.calls.push("ROLLBACK");
    this.pendingInsert = null;
  }
}

async function main(): Promise<void> {
  const {
    consumeMysqlInternalRequestReplay,
    DurableInternalRequestReplayGuard,
    mysqlReplayCapacityLockName,
  } = await import(
    "../src/repositories/internal-request-replay-repository.js"
  );

  const productionLock = mysqlReplayCapacityLockName("spx_production");
  assert.equal(productionLock, mysqlReplayCapacityLockName("spx_production"));
  assert.notEqual(productionLock, mysqlReplayCapacityLockName("spx_staging"));
  assert.ok(Buffer.byteLength(productionLock, "utf8") <= 64);
  assert.equal(productionLock.includes("spx_production"), false);

  const broker = new LockBroker();
  const state: SharedState = { rows: new Set() };
  const now = new Date("2026-07-11T00:00:00.000Z");
  const connections = [
    new FakeMysqlConnection(broker, state),
    new FakeMysqlConnection(broker, state),
  ];
  const results = await Promise.all(connections.map((connection, index) => (
    consumeMysqlInternalRequestReplay(connection, {
      expiresAt: new Date(now.getTime() + 120_001),
      fingerprint: String(index + 1).padStart(64, "0"),
      nodeId: `node-${index + 1}`,
      now,
      partition: "realtime-events",
      requestId: `request-${index + 1}`,
    }, {
      cleanupBatchSize: 100,
      maxEntries: 1,
      maxEntriesPerPartition: 1,
    })
  )));

  assert.deepEqual(results.sort(), ["capacity", "consumed"]);
  assert.equal(state.rows.size, 1);
  assert.equal(
    broker.maxActiveFor(productionLock),
    1,
    "capacity transaction must be serialized across connections for one schema",
  );
  for (const connection of connections) {
    assert.deepEqual(connection.lockNames, [productionLock]);
    const getLock = connection.calls.findIndex((call) => /GET_LOCK/.test(call));
    const begin = connection.calls.indexOf("BEGIN");
    const count = connection.calls.findIndex((call) => /SELECT COUNT/.test(call));
    const releaseLock = connection.calls.findIndex((call) => /RELEASE_LOCK/.test(call));
    assert.ok(getLock >= 0 && begin > getLock && count > begin && releaseLock > count);
  }

  const isolatedBroker = new LockBroker();
  const productionConnection = new FakeMysqlConnection(
    isolatedBroker,
    { rows: new Set() },
    "spx_production",
  );
  const stagingConnection = new FakeMysqlConnection(
    isolatedBroker,
    { rows: new Set() },
    "spx_staging",
  );
  const isolatedResults = await Promise.all([
    consumeMysqlInternalRequestReplay(productionConnection, {
      expiresAt: new Date(now.getTime() + 120_001),
      fingerprint: "3".padStart(64, "0"),
      nodeId: "production-node",
      now,
      partition: "realtime-events",
      requestId: "production-request",
    }, {
      cleanupBatchSize: 100,
      maxEntries: 1,
      maxEntriesPerPartition: 1,
    }),
    consumeMysqlInternalRequestReplay(stagingConnection, {
      expiresAt: new Date(now.getTime() + 120_001),
      fingerprint: "4".padStart(64, "0"),
      nodeId: "staging-node",
      now,
      partition: "realtime-events",
      requestId: "staging-request",
    }, {
      cleanupBatchSize: 100,
      maxEntries: 1,
      maxEntriesPerPartition: 1,
    }),
  ]);
  assert.deepEqual(isolatedResults, ["consumed", "consumed"]);
  assert.deepEqual(productionConnection.lockNames, [productionLock]);
  assert.deepEqual(stagingConnection.lockNames, [mysqlReplayCapacityLockName("spx_staging")]);
  assert.equal(
    isolatedBroker.maxActiveGlobal,
    2,
    "different schemas on the same MySQL host must not contend on one capacity lock",
  );

  const replayFingerprint = "5".padStart(64, "0");
  const replayConnection = new FakeMysqlConnection(
    new LockBroker(),
    { rows: new Set([replayFingerprint]) },
  );
  assert.equal(await consumeMysqlInternalRequestReplay(replayConnection, {
    expiresAt: new Date(now.getTime() + 120_001),
    fingerprint: replayFingerprint,
    nodeId: "replay-node",
    now,
    partition: "realtime-events",
    requestId: "replay-request",
  }, {
    cleanupBatchSize: 100,
    maxEntries: 100,
    maxEntriesPerPartition: 100,
  }), "replay");
  assert.equal(
    replayConnection.calls.some((call) => /GET_LOCK|SELECT COUNT/.test(call) || call === "BEGIN"),
    false,
    "an indexed exact-replay hit must bypass the capacity lock and count queries",
  );

  const raceBroker = new LockBroker();
  const raceState: SharedState = { rows: new Set() };
  const raceFingerprint = "6".padStart(64, "0");
  const raceConnections = [
    new FakeMysqlConnection(raceBroker, raceState),
    new FakeMysqlConnection(raceBroker, raceState),
  ];
  const raceResults = await Promise.all(raceConnections.map((connection, index) => (
    consumeMysqlInternalRequestReplay(connection, {
      expiresAt: new Date(now.getTime() + 120_001),
      fingerprint: raceFingerprint,
      nodeId: `race-node-${index + 1}`,
      now,
      partition: "realtime-events",
      requestId: `race-request-${index + 1}`,
    }, {
      cleanupBatchSize: 100,
      maxEntries: 100,
      maxEntriesPerPartition: 100,
    })
  )));
  assert.deepEqual(raceResults.sort(), ["consumed", "replay"]);
  assert.equal(raceState.rows.size, 1);
  assert.equal(
    raceConnections.filter((connection) => connection.calls.some((call) => /SELECT COUNT/.test(call))).length,
    1,
    "the post-lock key check must close the absent-read race before capacity scans",
  );

  const duplicateConnection = new FakeMysqlConnection(
    new LockBroker(),
    { rows: new Set() },
    "spx_production",
    { insertError: Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY", errno: 1062 }) },
  );
  assert.equal(await consumeMysqlInternalRequestReplay(duplicateConnection, {
    expiresAt: new Date(now.getTime() + 120_001),
    fingerprint: "7".padStart(64, "0"),
    nodeId: "duplicate-node",
    now,
    partition: "realtime-events",
    requestId: "duplicate-request",
  }, {
    cleanupBatchSize: 100,
    maxEntries: 100,
    maxEntriesPerPartition: 100,
  }), "replay");
  assert.ok(duplicateConnection.calls.includes("ROLLBACK"));
  assert.ok(duplicateConnection.calls.findIndex((call) => /RELEASE_LOCK/.test(call))
    > duplicateConnection.calls.indexOf("ROLLBACK"));

  const databaseErrorConnection = new FakeMysqlConnection(
    new LockBroker(),
    { rows: new Set() },
    "spx_production",
    { insertError: new Error("database unavailable") },
  );
  await assert.rejects(() => consumeMysqlInternalRequestReplay(databaseErrorConnection, {
    expiresAt: new Date(now.getTime() + 120_001),
    fingerprint: "8".padStart(64, "0"),
    nodeId: "error-node",
    now,
    partition: "realtime-events",
    requestId: "error-request",
  }, {
    cleanupBatchSize: 100,
    maxEntries: 100,
    maxEntriesPerPartition: 100,
  }));
  assert.ok(databaseErrorConnection.calls.includes("ROLLBACK"));
  assert.ok(databaseErrorConnection.calls.findIndex((call) => /RELEASE_LOCK/.test(call))
    > databaseErrorConnection.calls.indexOf("ROLLBACK"));

  const rawGuardInput = {
    nodeId: "guard-node",
    requestId: "guard-request",
    signedTimestamp: now.toISOString(),
    partition: "realtime-events",
    now,
  };
  const failClosedThroughGuard = async (connection: FakeMysqlConnection) => (
    new DurableInternalRequestReplayGuard({
      store: {
        consume: (input, limits) => consumeMysqlInternalRequestReplay(connection, input, limits),
      },
    }).consume(rawGuardInput)
  );

  const timeoutConnection = new FakeMysqlConnection(
    new LockBroker(),
    { rows: new Set() },
    "spx_production",
    { lockAcquired: 0 },
  );
  assert.deepEqual(await failClosedThroughGuard(timeoutConnection), { ok: false, reason: "capacity" });
  assert.equal(timeoutConnection.calls.includes("BEGIN"), false);
  assert.equal(timeoutConnection.calls.some((call) => /RELEASE_LOCK/.test(call)), false);

  const releaseFailureConnection = new FakeMysqlConnection(
    new LockBroker(),
    { rows: new Set() },
    "spx_production",
    { releaseResult: 0 },
  );
  assert.deepEqual(await failClosedThroughGuard(releaseFailureConnection), {
    ok: false,
    reason: "capacity",
  });
  assert.ok(releaseFailureConnection.calls.includes("COMMIT"));
  assert.ok(releaseFailureConnection.calls.some((call) => /RELEASE_LOCK/.test(call)));

  const capacityConnection = connections.find((connection) => (
    connection.calls.includes("COMMIT")
    && connection.calls.some((call) => /SELECT COUNT/.test(call))
    && !connection.calls.some((call) => /^INSERT/.test(call))
  ));
  assert.ok(capacityConnection, "the capacity path must commit bounded cleanup");
  assert.ok(capacityConnection.calls.findIndex((call) => /RELEASE_LOCK/.test(call))
    > capacityConnection.calls.indexOf("COMMIT"));

  console.log("durable internal replay MySQL serialization tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
