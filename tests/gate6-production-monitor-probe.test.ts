import assert from "node:assert/strict";

import {
  executeGate6ProductionMonitorProbe,
} from "../scripts/gate6-production-monitor-probe.mjs";

class Connection {
  constructor(private readonly responses: unknown[]) {}
  async execute(): Promise<[unknown, unknown]> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected query");
    return [response, []];
  }
}

async function main(): Promise<void> {
  const connection = new Connection([
    [{ queue_oldest_ms: 120 }],
    [{ outbox_oldest_ms: 80 }],
    [{ stale_count: 0, team_1_active_count: 1, team_2_active_count: 1 }],
    [{ Value: "20" }],
    [{ Value: "100" }],
  ]);
  const result = await executeGate6ProductionMonitorProbe({
    connection,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    monotonicNow: () => 0,
    now: new Date("2026-07-11T02:00:00.000Z"),
  });
  assert.deepEqual(result, {
    ok: true,
    readiness: true,
    latencyMs: 0,
    queueOldestMs: 120,
    outboxOldestMs: 80,
    leaseStaleCount: 0,
    missingLeaseTeamIds: [],
    mysqlConnectionPercent: 20,
    checkedAt: "2026-07-11T02:00:00.000Z",
  });

  for (const leaseRow of [
    { stale_count: 0, team_1_active_count: 0, team_2_active_count: 0 },
    { stale_count: 0, team_1_active_count: 0, team_2_active_count: 0 },
  ]) {
    const unavailable = await executeGate6ProductionMonitorProbe({
      connection: new Connection([
        [{ queue_oldest_ms: 0 }],
        [{ outbox_oldest_ms: 0 }],
        [leaseRow],
        [{ Value: "1" }],
        [{ Value: "100" }],
      ]),
      fetchImpl: async () => ({ ok: true, status: 200 }),
      monotonicNow: () => 0,
      now: new Date("2026-07-11T02:00:00.000Z"),
    });
    assert.deepEqual(unavailable.missingLeaseTeamIds, [1, 2]);
  }
  console.log("Gate 6 production monitor probe tests passed");
}

void main();
