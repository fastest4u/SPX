import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { teamRuntimeDesiredState } from "../src/db/schema.js";
import { createRoleAwareTeamRuntimeActions } from "../src/services/team-runtime-actions.js";
import { TeamRuntimeManager, type TeamRuntimeLeaseOptions } from "../src/services/team-runtime-manager.js";
import type { TeamRuntimeConfig } from "../src/repositories/team-repository.js";

const teams: TeamRuntimeConfig[] = [
  { id: 1, name: "IFN", enabled: true, spxCookie: "cookie-1", spxDeviceId: "device-1", lineGroupId: "group-1" },
  { id: 2, name: "PTWL", enabled: true, spxCookie: "cookie-2", spxDeviceId: "device-2", lineGroupId: "group-2" },
];

function createManager(options: { assignedTeamIds?: number[]; lease?: TeamRuntimeLeaseOptions } = {}): {
  manager: TeamRuntimeManager;
  events: string[];
} {
  const events: string[] = [];
  const manager = new TeamRuntimeManager({
    assignedTeamIds: options.assignedTeamIds,
    lease: options.lease,
    loadEnabledTeams: async () => teams,
    loadTeam: async (teamId) => teams.find((team) => team.id === teamId) ?? null,
    createRuntime: (team) => {
      let status: "stopped" | "running" | "paused" = "stopped";
      events.push(`create:${team.id}`);
      return {
        teamId: team.id,
        start: async () => { status = "running"; events.push(`start:${team.id}`); },
        stop: async () => { status = "stopped"; events.push(`stop:${team.id}`); },
        pause: async () => { status = "paused"; events.push(`pause:${team.id}`); },
        resume: async () => { status = "running"; events.push(`resume:${team.id}`); },
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
  });
  return { manager, events };
}

async function main(): Promise<void> {
  {
    const { manager, events } = createManager({ assignedTeamIds: [2] });

    await manager.startAllEnabledTeams();

    assert.deepEqual(events, ["create:2", "start:2"]);
    assert.equal(manager.getStatus(1), null);
    assert.equal(manager.getStatus(2)?.status, "running");
  }

  {
    const { manager, events } = createManager({ assignedTeamIds: [2] });

    await assert.rejects(
      () => manager.restartTeam(1),
      /Team 1 is not assigned to this runtime node/,
    );

    assert.deepEqual(events, []);
    assert.equal(manager.getStatus(1), null);
  }

  {
    const { manager, events } = createManager();

    await manager.startAllEnabledTeams();

    assert.deepEqual(events, ["create:1", "start:1", "create:2", "start:2"]);
    assert.equal(manager.getStatus(1)?.status, "running");
    assert.equal(manager.getStatus(2)?.status, "running");
  }

  {
    const { manager, events } = createManager({ assignedTeamIds: [] });

    await manager.startAllEnabledTeams();

    assert.deepEqual(events, ["create:1", "start:1", "create:2", "start:2"]);
    assert.equal(manager.getStatus(1)?.status, "running");
    assert.equal(manager.getStatus(2)?.status, "running");
  }

  {
    await closePool();
    resetMemoryDb();
    const { manager, events } = createManager();
    const actions = createRoleAwareTeamRuntimeActions(manager, false);

    assert.equal(typeof actions.restartTeam, "function");
    assert.equal(typeof actions.pauseTeam, "function");
    assert.equal(typeof actions.resumeTeam, "function");
    assert.equal(typeof actions.stopTeam, "function");
    assert.equal(actions.getStatus?.(1), null);

    await actions.restartTeam?.(2);
    await actions.pauseTeam?.(2);
    await actions.resumeTeam?.(2);
    await actions.stopTeam?.(2);

    const db = await getDb();
    const [row] = await db
      .select()
      .from(teamRuntimeDesiredState)
      .where(eq(teamRuntimeDesiredState.teamId, 2))
      .limit(1);

    assert.equal(row?.desiredState, "stopped");
    assert.match(row?.reason ?? "", /stop/i);
    assert.deepEqual(events, []);
  }

  {
    const { manager, events } = createManager({ assignedTeamIds: [2] });
    const actions = createRoleAwareTeamRuntimeActions(manager, true);

    assert.equal(typeof actions.restartTeam, "function");
    await actions.restartTeam?.(2);

    assert.deepEqual(events, ["create:2", "start:2"]);
    assert.equal(actions.getStatus?.(2)?.status, "running");
  }

  {
    const heldLeases = new Map<number, { nodeId: string; leaseToken: string }>();
    const leaseFor = (nodeId: string): TeamRuntimeLeaseOptions => ({
      nodeId,
      role: "worker",
      ttlMs: 30_000,
      renewIntervalMs: 60_000,
      acquire: async ({ teamId }) => {
        const current = heldLeases.get(teamId);
        if (current && current.nodeId !== nodeId) return { acquired: false };
        const leaseToken = `${nodeId}:${teamId}`;
        heldLeases.set(teamId, { nodeId, leaseToken });
        return { acquired: true, leaseToken };
      },
      renew: async ({ teamId, leaseToken }) => heldLeases.get(teamId)?.leaseToken === leaseToken,
      release: async ({ teamId, leaseToken }) => {
        if (heldLeases.get(teamId)?.leaseToken !== leaseToken) return false;
        heldLeases.delete(teamId);
        return true;
      },
    });
    const first = createManager({ assignedTeamIds: [2], lease: leaseFor("worker-a") });
    const second = createManager({ assignedTeamIds: [2], lease: leaseFor("worker-b") });

    await first.manager.startAllEnabledTeams();
    await second.manager.startAllEnabledTeams();

    assert.deepEqual(first.events, ["create:2", "start:2"]);
    assert.deepEqual(second.events, []);
    assert.equal(second.manager.getStatus(2)?.status, "stopped");
    assert.match(second.manager.getStatus(2)?.lastError ?? "", /lease is held/);

    await first.manager.stopAll();
    await second.manager.startAllEnabledTeams();

    assert.deepEqual(second.events, ["create:2", "start:2"]);
    assert.equal(second.manager.getStatus(2)?.status, "running");
    await second.manager.stopAll();
  }

  {
    const { manager, events } = createManager({
      assignedTeamIds: [2],
      lease: {
        nodeId: "throwing-renew-worker",
        role: "worker",
        ttlMs: 20,
        renewIntervalMs: 5,
        acquire: async ({ teamId }) => ({ acquired: true, leaseToken: `lease:${teamId}` }),
        renew: async () => {
          throw new Error("database unavailable");
        },
        release: async () => true,
      },
    });

    await manager.startAllEnabledTeams();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.deepEqual(events, ["create:2", "start:2", "stop:2"]);
    assert.equal(manager.getStatus(2)?.status, "stopped");
    assert.match(manager.getStatus(2)?.lastError ?? "", /lease renew failed/i);
  }

  await closePool();
  console.log("team-runtime-manager-assignment: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
