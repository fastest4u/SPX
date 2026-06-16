import { getTeamRuntimeConfig, listEnabledTeamRuntimeConfigs, type TeamRuntimeConfig } from "../repositories/team-repository.js";
import { TeamRuntime, type TeamRuntimeHandle, type TeamRuntimeStatus } from "./team-runtime.js";

export interface TeamRuntimeManagerOptions {
  loadEnabledTeams?: () => Promise<TeamRuntimeConfig[]>;
  loadTeam?: (teamId: number) => Promise<TeamRuntimeConfig | null>;
  createRuntime?: (team: TeamRuntimeConfig) => TeamRuntimeHandle;
  intervalSec?: number;
}

export class TeamRuntimeManager {
  private readonly loadEnabledTeams: () => Promise<TeamRuntimeConfig[]>;
  private readonly loadTeam: (teamId: number) => Promise<TeamRuntimeConfig | null>;
  private readonly createRuntime: (team: TeamRuntimeConfig) => TeamRuntimeHandle;
  private readonly runtimes = new Map<number, TeamRuntimeHandle>();
  private readonly lastStatuses = new Map<number, TeamRuntimeStatus>();
  private readonly teamConfigs = new Map<number, TeamRuntimeConfig>();

  constructor(options: TeamRuntimeManagerOptions = {}) {
    this.loadEnabledTeams = options.loadEnabledTeams ?? listEnabledTeamRuntimeConfigs;
    this.loadTeam = options.loadTeam ?? getTeamRuntimeConfig;
    this.createRuntime = options.createRuntime ?? ((team) => new TeamRuntime(team, { intervalSec: options.intervalSec }));
  }

  async startAllEnabledTeams(): Promise<void> {
    const teams = await this.loadEnabledTeams();
    this.teamConfigs.clear();

    for (const team of teams) {
      this.teamConfigs.set(team.id, team);
      if (!this.hasRequiredCredentials(team)) {
        this.lastStatuses.set(team.id, this.misconfiguredStatus(team));
        continue;
      }

      const existing = this.runtimes.get(team.id);
      if (existing) {
        this.lastStatuses.set(team.id, existing.status());
        continue;
      }

      const runtime = this.createRuntime(team);
      this.runtimes.set(team.id, runtime);
      try {
        await runtime.start();
        this.lastStatuses.set(team.id, runtime.status());
      } catch (error) {
        this.lastStatuses.set(team.id, {
          teamId: team.id,
          teamName: team.name,
          status: "error",
          lastPollAt: null,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  getStatus(teamId: number): TeamRuntimeStatus | null {
    return this.runtimes.get(teamId)?.status() ?? this.lastStatuses.get(teamId) ?? null;
  }

  listStatuses(): TeamRuntimeStatus[] {
    const statuses = new Map<number, TeamRuntimeStatus>();
    for (const [teamId, status] of this.lastStatuses) statuses.set(teamId, status);
    for (const [teamId, runtime] of this.runtimes) statuses.set(teamId, runtime.status());
    return [...statuses.values()].sort((a, b) => a.teamId - b.teamId);
  }

  async pauseTeam(teamId: number): Promise<void> {
    const runtime = this.requireRuntime(teamId);
    await runtime.pause();
    this.lastStatuses.set(teamId, runtime.status());
  }

  async resumeTeam(teamId: number): Promise<void> {
    const runtime = this.requireRuntime(teamId);
    await runtime.resume();
    this.lastStatuses.set(teamId, runtime.status());
  }

  async restartTeam(teamId: number): Promise<void> {
    const existing = this.runtimes.get(teamId);
    if (existing) {
      await existing.stop();
      this.runtimes.delete(teamId);
      this.lastStatuses.set(teamId, existing.status());
    }

    const team = await this.loadTeam(teamId);
    if (!team) throw new Error(`Team ${teamId} was not found`);
    this.teamConfigs.set(team.id, team);

    if (!team.enabled) {
      this.lastStatuses.set(team.id, {
        teamId: team.id,
        teamName: team.name,
        status: "stopped",
        lastPollAt: null,
        lastError: "Team is disabled",
      });
      return;
    }

    if (!this.hasRequiredCredentials(team)) {
      this.lastStatuses.set(team.id, this.misconfiguredStatus(team));
      return;
    }

    const runtime = this.createRuntime(team);
    this.runtimes.set(team.id, runtime);
    try {
      await runtime.start();
      this.lastStatuses.set(team.id, runtime.status());
    } catch (error) {
      this.runtimes.delete(team.id);
      this.lastStatuses.set(team.id, {
        teamId: team.id,
        teamName: team.name,
        status: "error",
        lastPollAt: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stopTeam(teamId: number): Promise<void> {
    const runtime = this.runtimes.get(teamId);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(teamId);
      this.lastStatuses.set(teamId, runtime.status());
      return;
    }

    const known = this.lastStatuses.get(teamId);
    if (known) {
      this.lastStatuses.set(teamId, { ...known, status: "stopped", lastError: null });
    }
  }

  async restartAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
    this.runtimes.clear();
    await this.startAllEnabledTeams();
  }

  async stopAll(): Promise<void> {
    for (const [teamId, runtime] of this.runtimes) {
      await runtime.stop();
      this.lastStatuses.set(teamId, runtime.status());
    }
    this.runtimes.clear();
  }

  private requireRuntime(teamId: number): TeamRuntimeHandle {
    const runtime = this.runtimes.get(teamId);
    if (!runtime) {
      const known = this.lastStatuses.get(teamId);
      throw new Error(known?.lastError || `Team runtime ${teamId} is not running`);
    }
    return runtime;
  }

  private hasRequiredCredentials(team: TeamRuntimeConfig): boolean {
    return Boolean(team.enabled && team.spxCookie && team.spxDeviceId);
  }

  private misconfiguredStatus(team: TeamRuntimeConfig): TeamRuntimeStatus {
    return {
      teamId: team.id,
      teamName: team.name,
      status: "misconfigured",
      lastPollAt: null,
      lastError: "Team SPX credentials are incomplete",
    };
  }
}
