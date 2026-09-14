import assert from "node:assert/strict";
import { TeamRuntimeManager } from "../src/services/team-runtime-manager.js";
import { clearPausedTeams, isTeamPaused } from "../src/services/poller-control.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function testConcurrentRestartsAreSerialized(): Promise<void> {
  const firstStopStarted = deferred();
  const releaseFirstStop = deferred();
  let createdRuntimes = 0;
  let activeRuntimes = 0;
  let maxActiveRuntimes = 0;

  const manager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [
      { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" },
    ],
    loadTeam: async () => (
      { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" }
    ),
    createRuntime: (team) => {
      const runtimeNumber = ++createdRuntimes;
      let status: "stopped" | "running" = "stopped";
      let stopping = false;
      return {
        teamId: team.id,
        start: async () => {
          status = "running";
          activeRuntimes++;
          maxActiveRuntimes = Math.max(maxActiveRuntimes, activeRuntimes);
        },
        stop: async () => {
          // Match Poller.stop(): a second caller returns while the first stop
          // still waits for its active tick to finish.
          if (stopping) return;
          stopping = true;
          if (runtimeNumber === 1) {
            firstStopStarted.resolve();
            await releaseFirstStop.promise;
          }
          if (status === "running") activeRuntimes--;
          status = "stopped";
        },
        pause: () => undefined,
        resume: () => undefined,
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
  });

  await manager.startAllEnabledTeams();
  const firstRestart = manager.restartTeam(1);
  await firstStopStarted.promise;
  const secondRestart = manager.restartTeam(1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(createdRuntimes, 1, "a second restart must wait for the in-flight stop");
  releaseFirstStop.resolve();
  await Promise.all([firstRestart, secondRestart]);

  assert.equal(maxActiveRuntimes, 1, "restart overlap must never run two pollers for one team");
  assert.equal(activeRuntimes, 1, "only the final replacement poller remains active");
  await manager.stopTeam(1);
  assert.equal(activeRuntimes, 0, "the final poller remains reachable by the manager");
}

async function testConcurrentDesiredStateReconciliationIsSingleFlight(): Promise<void> {
  const firstStopStarted = deferred();
  const releaseFirstStop = deferred();
  let desiredState: "restart" | "running" = "running";
  let desiredStateReads = 0;
  let appliedRestarts = 0;
  let createdRuntimes = 0;
  let activeRuntimes = 0;

  const manager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [
      { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" },
    ],
    loadTeam: async () => (
      { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" }
    ),
    createRuntime: (team) => {
      const runtimeNumber = ++createdRuntimes;
      let status: "stopped" | "running" = "stopped";
      return {
        teamId: team.id,
        start: async () => {
          status = "running";
          activeRuntimes++;
        },
        stop: async () => {
          if (runtimeNumber === 1) {
            firstStopStarted.resolve();
            await releaseFirstStop.promise;
          }
          if (status === "running") activeRuntimes--;
          status = "stopped";
        },
        pause: () => undefined,
        resume: () => undefined,
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
    desiredState: {
      list: async () => {
        desiredStateReads++;
        return [{ teamId: 1, desiredState }];
      },
      set: async ({ desiredState: appliedState }) => {
        if (appliedState === "running") appliedRestarts++;
        desiredState = appliedState === "restart" ? "restart" : "running";
      },
    },
  });

  await manager.startAllEnabledTeams();
  desiredState = "restart";
  const firstReconcile = manager.reconcileDesiredStates();
  await firstStopStarted.promise;
  const secondReconcile = manager.reconcileDesiredStates();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(desiredStateReads, 2, "a concurrent reconcile must reuse the in-flight desired-state read");
  releaseFirstStop.resolve();
  await Promise.all([firstReconcile, secondReconcile]);

  assert.equal(createdRuntimes, 2, "one desired restart creates exactly one replacement runtime");
  assert.equal(appliedRestarts, 1, "one desired restart is acknowledged once");
  assert.equal(activeRuntimes, 1);
  await manager.stopTeam(1);
  assert.equal(activeRuntimes, 0);
}

async function testRestartAllSerializesWithTeamRestart(): Promise<void> {
  const firstStopStarted = deferred();
  const releaseFirstStop = deferred();
  let createdRuntimes = 0;
  let activeRuntimes = 0;
  let maxActiveRuntimes = 0;

  const team = { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" };
  const manager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [team],
    loadTeam: async () => team,
    createRuntime: () => {
      const runtimeNumber = ++createdRuntimes;
      let status: "stopped" | "running" = "stopped";
      let stopping = false;
      return {
        teamId: team.id,
        start: async () => {
          status = "running";
          activeRuntimes++;
          maxActiveRuntimes = Math.max(maxActiveRuntimes, activeRuntimes);
        },
        stop: async () => {
          if (stopping) return;
          stopping = true;
          if (runtimeNumber === 1) {
            firstStopStarted.resolve();
            await releaseFirstStop.promise;
          }
          if (status === "running") activeRuntimes--;
          status = "stopped";
        },
        pause: () => undefined,
        resume: () => undefined,
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
  });

  await manager.startAllEnabledTeams();
  const restartAll = manager.restartAll();
  await firstStopStarted.promise;
  const restartTeam = manager.restartTeam(1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(createdRuntimes, 1, "Restart All and Restart Team must share the per-team lifecycle queue");
  releaseFirstStop.resolve();
  await Promise.all([restartAll, restartTeam]);

  assert.equal(maxActiveRuntimes, 1);
  assert.equal(activeRuntimes, 1);
  await manager.stopTeam(1);
  assert.equal(activeRuntimes, 0);
}

async function testDesiredPausedStartSerializesWithTeamRestart(): Promise<void> {
  const firstLoadStarted = deferred();
  const releaseFirstLoad = deferred();
  let loadCalls = 0;
  let createdRuntimes = 0;
  let activeRuntimes = 0;
  let maxActiveRuntimes = 0;
  const team = { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" };

  const manager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [team],
    loadTeam: async () => {
      loadCalls++;
      if (loadCalls === 1) {
        firstLoadStarted.resolve();
        await releaseFirstLoad.promise;
      }
      return team;
    },
    createRuntime: () => {
      let status: "stopped" | "running" | "paused" = "stopped";
      return {
        teamId: team.id,
        start: async () => {
          status = "running";
          createdRuntimes++;
          activeRuntimes++;
          maxActiveRuntimes = Math.max(maxActiveRuntimes, activeRuntimes);
        },
        stop: async () => {
          if (status !== "stopped") activeRuntimes--;
          status = "stopped";
        },
        pause: () => { status = "paused"; },
        resume: () => { status = "running"; },
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
    desiredState: {
      list: async () => [{ teamId: 1, desiredState: "paused" as const }],
      set: async () => undefined,
    },
  });

  const reconcile = manager.reconcileDesiredStates();
  await firstLoadStarted.promise;
  const restart = manager.restartTeam(1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(createdRuntimes, 0, "desired-state starts and direct restarts must share the per-team queue");
  releaseFirstLoad.resolve();
  await Promise.all([reconcile, restart]);

  assert.equal(maxActiveRuntimes, 1);
  assert.equal(activeRuntimes, 1);
  await manager.stopTeam(1);
  assert.equal(activeRuntimes, 0);
}

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

  let desiredStates: Array<{ teamId: number; desiredState: "restart" | "running" | "paused" | "stopped" }> = [
    { teamId: 1, desiredState: "running" },
  ];
  const appliedDesiredStates: string[] = [];
  version = "v1";
  events.length = 0;
  const desiredManager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [
      { id: 1, name: `A-${version}`, enabled: true, spxCookie: `ca-${version}`, spxDeviceId: "da", lineGroupId: "ga" },
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
    desiredState: {
      list: async () => desiredStates,
      set: async ({ teamId, desiredState }) => {
        appliedDesiredStates.push(`${teamId}:${desiredState}`);
        desiredStates = desiredStates.map((state) =>
          state.teamId === teamId ? { ...state, desiredState } : state
        );
      },
    },
  });

  await desiredManager.startAllEnabledTeams();
  version = "v2";
  desiredStates = [{ teamId: 1, desiredState: "restart" }];
  await desiredManager.reconcileDesiredStates();

  assert.deepEqual(events, ["start:1:ca-v1", "stop:1", "start:1:ca-v2"]);
  assert.deepEqual(appliedDesiredStates, ["1:running"]);
  assert.equal(desiredManager.getStatus(1)?.status, "running");

  clearPausedTeams();
  events.length = 0;
  const startupDesiredManager = new TeamRuntimeManager({
    loadEnabledTeams: async () => [
      { id: 1, name: "Stopped", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" },
      { id: 2, name: "Paused", enabled: true, spxCookie: "cb", spxDeviceId: "db", lineGroupId: "gb" },
    ],
    createRuntime: (team) => {
      let status: "stopped" | "running" | "paused" = "stopped";
      return {
        teamId: team.id,
        start: async () => {
          status = isTeamPaused(team.id) ? "paused" : "running";
          events.push(`start:${team.id}:${status}`);
        },
        stop: async () => { status = "stopped"; events.push(`stop:${team.id}`); },
        pause: () => { status = "paused"; events.push(`pause:${team.id}`); },
        resume: () => { status = "running"; events.push(`resume:${team.id}`); },
        status: () => ({ teamId: team.id, teamName: team.name, status, lastPollAt: null, lastError: null }),
      };
    },
    desiredState: {
      list: async () => [
        { teamId: 1, desiredState: "stopped" },
        { teamId: 2, desiredState: "paused" },
      ],
      set: async () => undefined,
    },
  });

  await startupDesiredManager.startAllEnabledTeams();
  assert.deepEqual(events, ["start:2:paused", "pause:2"]);
  assert.equal(startupDesiredManager.getStatus(1)?.status, "stopped");
  assert.equal(startupDesiredManager.getStatus(2)?.status, "paused");
  clearPausedTeams();

  await testConcurrentRestartsAreSerialized();
  await testConcurrentDesiredStateReconciliationIsSingleFlight();
  await testRestartAllSerializesWithTeamRestart();
  await testDesiredPausedStartSerializesWithTeamRestart();

  console.log("team-runtime-manager: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
