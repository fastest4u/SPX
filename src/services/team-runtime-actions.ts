import { listEnabledTeamRuntimeConfigs } from "../repositories/team-repository.js";
import { setTeamRuntimeDesiredState, type TeamRuntimeDesiredStateValue } from "../repositories/runtime-repository.js";
import type { TeamRuntimeManager } from "./team-runtime-manager.js";

export interface TeamRuntimeActions {
  restartTeam?: (teamId: number) => Promise<unknown>;
  pauseTeam?: (teamId: number) => Promise<unknown>;
  resumeTeam?: (teamId: number) => Promise<unknown>;
  stopTeam?: (teamId: number) => Promise<unknown>;
  restartAll?: () => Promise<unknown>;
  getStatus?: (teamId: number) => { status: string } | null;
}

export function createRoleAwareTeamRuntimeActions(
  runtimeManager: TeamRuntimeManager,
  workersEnabled: boolean,
): TeamRuntimeActions {
  const enqueue = async (teamId: number, desiredState: TeamRuntimeDesiredStateValue, reason: string): Promise<void> => {
    await setTeamRuntimeDesiredState({ teamId, desiredState, reason });
  };

  return {
    restartTeam: workersEnabled
      ? (teamId) => runtimeManager.restartTeam(teamId)
      : (teamId) => enqueue(teamId, "restart", "restart requested from central API"),
    pauseTeam: workersEnabled
      ? (teamId) => runtimeManager.pauseTeam(teamId)
      : (teamId) => enqueue(teamId, "paused", "pause requested from central API"),
    resumeTeam: workersEnabled
      ? (teamId) => runtimeManager.resumeTeam(teamId)
      : (teamId) => enqueue(teamId, "running", "resume requested from central API"),
    stopTeam: workersEnabled
      ? (teamId) => runtimeManager.stopTeam(teamId)
      : (teamId) => enqueue(teamId, "stopped", "stop requested from central API"),
    restartAll: workersEnabled
      ? () => runtimeManager.restartAll()
      : async () => {
        const teams = await listEnabledTeamRuntimeConfigs();
        await Promise.all(teams.map((team) => enqueue(team.id, "restart", "restart-all requested from central API")));
      },
    getStatus: (teamId) => runtimeManager.getStatus(teamId),
  };
}
