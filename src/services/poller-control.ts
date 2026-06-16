const pausedTeams = new Set<number>();

export function isTeamPaused(teamId: number): boolean {
  return pausedTeams.has(teamId);
}

export function pauseTeam(teamId: number): void {
  pausedTeams.add(teamId);
}

export function resumeTeam(teamId: number): void {
  pausedTeams.delete(teamId);
}

export function clearPausedTeams(): void {
  pausedTeams.clear();
}

export const pollerControl = {
  get isPaused(): boolean {
    return isTeamPaused(1);
  },
  set isPaused(value: boolean) {
    if (value) pauseTeam(1);
    else resumeTeam(1);
  },
};
