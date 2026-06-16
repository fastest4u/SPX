import assert from "node:assert/strict";
import { TeamRuntimeManager } from "../src/services/team-runtime-manager.js";

async function main(): Promise<void> {
  const events: string[] = [];
  let version = "v1";
  const manager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [
      { id: 1, name: `A-${version}`, enabled: true, spxCookie: `ca-${version}`, spxDeviceId: "da", lineGroupId: "ga" },
      { id: 2, name: "B", enabled: true, spxCookie: "", spxDeviceId: "db", lineGroupId: "gb" },
    ],
    loadTeam: async (teamId) => {
      if (teamId !== 1) return null;
      return { id: 1, name: `A-${version}`, enabled: true, spxCookie: `ca-${version}`, spxDeviceId: "da", lineGroupId: "ga" };
    },
    createRuntime: (team) => {
      let status: "stopped" | "running" | "paused" = "stopped";
      return {
        teamId: team.id,
        start: async () => { status = "running"; events.push(`start:${team.id}:${team.spxCookie}`); },
        stop: async () => { status = "stopped"; events.push(`stop:${team.id}`); },
        pause: () => { status = "paused"; events.push(`pause:${team.id}`); },
        resume: () => { status = "running"; events.push(`resume:${team.id}`); },
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
  });

  await manager.startAllEnabledTeams();
  assert.deepEqual(events, ["start:1:ca-v1"]);
  assert.equal(manager.getStatus(2)?.status, "misconfigured");

  await manager.pauseTeam(1);
  await manager.resumeTeam(1);
  version = "v2";
  await manager.restartTeam(1);
  assert.deepEqual(events, ["start:1:ca-v1", "pause:1", "resume:1", "stop:1", "start:1:ca-v2"]);

  await manager.stopTeam(1);
  assert.equal(manager.getStatus(1)?.status, "stopped");
  await manager.stopTeam(2);
  assert.equal(manager.getStatus(2)?.status, "stopped");
  assert.deepEqual(events, ["start:1:ca-v1", "pause:1", "resume:1", "stop:1", "start:1:ca-v2", "stop:1"]);
  console.log("team-runtime-manager: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
