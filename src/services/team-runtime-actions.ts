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
  return {
    restartTeam: workersEnabled ? (teamId) => runtimeManager.restartTeam(teamId) : undefined,
    pauseTeam: workersEnabled ? (teamId) => runtimeManager.pauseTeam(teamId) : undefined,
    resumeTeam: workersEnabled ? (teamId) => runtimeManager.resumeTeam(teamId) : undefined,
    stopTeam: workersEnabled ? (teamId) => runtimeManager.stopTeam(teamId) : undefined,
    restartAll: workersEnabled ? () => runtimeManager.restartAll() : undefined,
    getStatus: (teamId) => runtimeManager.getStatus(teamId),
  };
}
