import { getTeamRuntimeConfig, listEnabledTeamRuntimeConfigs, type TeamRuntimeConfig } from "../repositories/team-repository.js";
import { listTeamRuntimeDesiredStates, setTeamRuntimeDesiredState, type SetTeamRuntimeDesiredStateInput, type TeamRuntimeDesiredStateValue } from "../repositories/runtime-repository.js";
import { logger } from "../utils/logger.js";
import { acquireTeamLease, releaseTeamLease, renewTeamLease, type AcquireTeamLeaseInput, type ReleaseTeamLeaseInput, type RenewTeamLeaseInput } from "./runtime-lease.js";
import { TeamRuntime, type TeamRuntimeHandle, type TeamRuntimeStatus } from "./team-runtime.js";

export interface TeamRuntimeLeaseOptions {
  nodeId: string;
  role: string;
  ttlMs: number;
  renewIntervalMs?: number;
  acquire?: (input: AcquireTeamLeaseInput) => Promise<{ acquired: boolean; leaseToken?: string }>;
  renew?: (input: RenewTeamLeaseInput) => Promise<boolean>;
  release?: (input: ReleaseTeamLeaseInput) => Promise<boolean>;
}

export interface TeamRuntimeManagerOptions {
  loadEnabledTeams?: () => Promise<TeamRuntimeConfig[]>;
  loadTeam?: (teamId: number) => Promise<TeamRuntimeConfig | null>;
  createRuntime?: (team: TeamRuntimeConfig) => TeamRuntimeHandle;
  intervalSec?: number;
  assignedTeamIds?: number[];
  lease?: TeamRuntimeLeaseOptions;
  desiredState?: TeamRuntimeDesiredStateOptions;
}

interface RuntimeLeaseState {
  leaseToken: string;
  renewTimer: ReturnType<typeof setInterval>;
  expiresAtMs: number;
}

type NormalizedTeamRuntimeLeaseOptions = Required<Pick<TeamRuntimeLeaseOptions, "nodeId" | "role" | "ttlMs" | "renewIntervalMs" | "acquire" | "renew" | "release">>;

export interface TeamRuntimeDesiredStateRecord {
  teamId: number;
  desiredState: TeamRuntimeDesiredStateValue;
}

export interface TeamRuntimeDesiredStateOptions {
  intervalMs?: number;
  list?: () => Promise<TeamRuntimeDesiredStateRecord[]>;
  set?: (input: SetTeamRuntimeDesiredStateInput) => Promise<void>;
}

type NormalizedTeamRuntimeDesiredStateOptions = Required<Pick<TeamRuntimeDesiredStateOptions, "intervalMs" | "list" | "set">>;

export interface TeamRuntimeDesiredStateLoop {
  stop(): void;
}

export class TeamRuntimeManager {
  private readonly loadEnabledTeams: () => Promise<TeamRuntimeConfig[]>;
  private readonly loadTeam: (teamId: number) => Promise<TeamRuntimeConfig | null>;
  private readonly createRuntime: (team: TeamRuntimeConfig) => TeamRuntimeHandle;
  private readonly assignedTeamIds: Set<number> | null;
  private readonly lease: NormalizedTeamRuntimeLeaseOptions | null;
  private readonly desiredState: NormalizedTeamRuntimeDesiredStateOptions | null;
  private readonly runtimes = new Map<number, TeamRuntimeHandle>();
  private readonly lastStatuses = new Map<number, TeamRuntimeStatus>();
  private readonly teamConfigs = new Map<number, TeamRuntimeConfig>();
  private readonly leases = new Map<number, RuntimeLeaseState>();
  private desiredStateLoop: TeamRuntimeDesiredStateLoop | null = null;

  constructor(options: TeamRuntimeManagerOptions = {}) {
    this.loadEnabledTeams = options.loadEnabledTeams ?? listEnabledTeamRuntimeConfigs;
    this.loadTeam = options.loadTeam ?? getTeamRuntimeConfig;
    this.createRuntime = options.createRuntime ?? ((team) => new TeamRuntime(team, { intervalSec: options.intervalSec }));
    this.assignedTeamIds = options.assignedTeamIds && options.assignedTeamIds.length > 0
      ? new Set(options.assignedTeamIds)
      : null;
    this.lease = options.lease ? {
      nodeId: options.lease.nodeId,
      role: options.lease.role,
      ttlMs: options.lease.ttlMs,
      renewIntervalMs: options.lease.renewIntervalMs ?? Math.max(1000, Math.floor(options.lease.ttlMs / 2)),
      acquire: options.lease.acquire ?? acquireTeamLease,
      renew: options.lease.renew ?? renewTeamLease,
      release: options.lease.release ?? releaseTeamLease,
    } : null;
    this.desiredState = options.desiredState ? {
      intervalMs: options.desiredState.intervalMs ?? 1_000,
      list: options.desiredState.list ?? listTeamRuntimeDesiredStates,
      set: options.desiredState.set ?? setTeamRuntimeDesiredState,
    } : null;
  }

  async startAllEnabledTeams(): Promise<void> {
    const teams = await this.loadEnabledTeams();
    this.teamConfigs.clear();

    for (const team of teams) {
      if (!this.isAssigned(team.id)) continue;

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

      if (!(await this.acquireRuntimeLease(team))) continue;

      const runtime = this.createRuntime(team);
      this.runtimes.set(team.id, runtime);
      try {
        await runtime.start();
        this.lastStatuses.set(team.id, runtime.status());
      } catch (error) {
        await this.releaseRuntimeLease(team.id);
        this.runtimes.delete(team.id);
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
    if (!this.isAssigned(teamId)) {
      throw new Error(`Team ${teamId} is not assigned to this runtime node`);
    }

    const existing = this.runtimes.get(teamId);
    if (existing) {
      await this.stopTeam(teamId);
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

    if (!(await this.acquireRuntimeLease(team))) return;

    const runtime = this.createRuntime(team);
    this.runtimes.set(team.id, runtime);
    try {
      await runtime.start();
      this.lastStatuses.set(team.id, runtime.status());
    } catch (error) {
      await this.releaseRuntimeLease(team.id);
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
      await this.releaseRuntimeLease(teamId);
      return;
    }

    await this.releaseRuntimeLease(teamId);
    const known = this.lastStatuses.get(teamId);
    if (known) {
      this.lastStatuses.set(teamId, { ...known, status: "stopped", lastError: null });
    }
  }

  async restartAll(): Promise<void> {
    await this.stopAllRuntimes();
    await this.startAllEnabledTeams();
  }

  async stopAll(): Promise<void> {
    this.stopDesiredStateLoop();
    await this.stopAllRuntimes();
  }

  async reconcileDesiredStates(): Promise<void> {
    if (!this.desiredState) return;
    const states = await this.desiredState.list();
    for (const state of states.sort((a, b) => a.teamId - b.teamId)) {
      if (!this.isAssigned(state.teamId)) continue;
      await this.applyDesiredState(state.teamId, state.desiredState);
    }
  }

  startDesiredStateLoop(): TeamRuntimeDesiredStateLoop {
    if (this.desiredStateLoop) return this.desiredStateLoop;
    const timer = setInterval(() => {
      void this.reconcileDesiredStates().catch((error) => {
        logger.warn("team-runtime-desired-state-reconcile-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.desiredState?.intervalMs ?? 1_000);
    timer.unref?.();
    const loop: TeamRuntimeDesiredStateLoop = {
      stop: () => {
        clearInterval(timer);
        if (this.desiredStateLoop === loop) this.desiredStateLoop = null;
      },
    };
    this.desiredStateLoop = loop;
    void this.reconcileDesiredStates().catch(() => undefined);
    return this.desiredStateLoop;
  }

  stopDesiredStateLoop(): void {
    const loop = this.desiredStateLoop;
    this.desiredStateLoop = null;
    loop?.stop();
  }

  private async acquireRuntimeLease(team: TeamRuntimeConfig): Promise<boolean> {
    if (!this.lease) return true;
    const result = await this.lease.acquire({
      teamId: team.id,
      nodeId: this.lease.nodeId,
      role: this.lease.role,
      ttlMs: this.lease.ttlMs,
    });
    if (!result.acquired || !result.leaseToken) {
      this.lastStatuses.set(team.id, {
        teamId: team.id,
        teamName: team.name,
        status: "stopped",
        lastPollAt: null,
        lastError: "Team runtime lease is held by another node",
      });
      logger.warn("team-runtime-lease-not-acquired", { teamId: team.id, nodeId: this.lease.nodeId });
      return false;
    }

    const renewTimer = setInterval(() => {
      void this.renewRuntimeLease(team.id, result.leaseToken!);
    }, this.lease.renewIntervalMs);
    renewTimer.unref?.();
    this.leases.set(team.id, {
      leaseToken: result.leaseToken,
      renewTimer,
      expiresAtMs: Date.now() + this.lease.ttlMs,
    });
    return true;
  }

  private async renewRuntimeLease(teamId: number, leaseToken: string): Promise<void> {
    if (!this.lease) return;
    try {
      const renewed = await this.lease.renew({
        teamId,
        nodeId: this.lease.nodeId,
        leaseToken,
        ttlMs: this.lease.ttlMs,
      });
      if (!renewed) {
        logger.warn("team-runtime-lease-renew-lost", { teamId, nodeId: this.lease.nodeId });
        await this.stopTeam(teamId);
      } else {
        const leaseState = this.leases.get(teamId);
        if (leaseState) leaseState.expiresAtMs = Date.now() + this.lease.ttlMs;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn("team-runtime-lease-renew-failed", {
        teamId,
        nodeId: this.lease.nodeId,
        error: errorMessage,
      });
      const leaseState = this.leases.get(teamId);
      if (leaseState && Date.now() >= leaseState.expiresAtMs) {
        await this.stopTeam(teamId);
        const known = this.lastStatuses.get(teamId);
        if (known) {
          this.lastStatuses.set(teamId, {
            ...known,
            lastError: `Lease renew failed before expiry: ${errorMessage}`,
          });
        }
      }
    }
  }

  private async releaseRuntimeLease(teamId: number): Promise<void> {
    if (!this.lease) return;
    const leaseState = this.leases.get(teamId);
    if (!leaseState) return;
    clearInterval(leaseState.renewTimer);
    this.leases.delete(teamId);
    try {
      await this.lease.release({
        teamId,
        nodeId: this.lease.nodeId,
        leaseToken: leaseState.leaseToken,
      });
    } catch (error) {
      logger.warn("team-runtime-lease-release-failed", {
        teamId,
        nodeId: this.lease.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  private isAssigned(teamId: number): boolean {
    return this.assignedTeamIds === null || this.assignedTeamIds.has(teamId);
  }

  private async applyDesiredState(teamId: number, desiredState: TeamRuntimeDesiredStateValue): Promise<void> {
    const status = this.getStatus(teamId)?.status;
    if (desiredState === "restart") {
      await this.restartTeam(teamId);
      await this.markDesiredStateApplied(teamId, "running", "restart applied by worker");
      return;
    }
    if (desiredState === "stopped") {
      if (status !== "stopped") await this.stopTeam(teamId);
      return;
    }
    if (desiredState === "paused") {
      if (status === "paused") return;
      if (!status || status === "stopped") await this.restartTeam(teamId);
      if (this.getStatus(teamId)?.status === "running") await this.pauseTeam(teamId);
      return;
    }
    if (desiredState === "running") {
      if (status === "running") return;
      if (status === "paused") {
        await this.resumeTeam(teamId);
        return;
      }
      await this.restartTeam(teamId);
    }
  }

  private async markDesiredStateApplied(
    teamId: number,
    desiredState: TeamRuntimeDesiredStateValue,
    reason: string,
  ): Promise<void> {
    if (!this.desiredState) return;
    await this.desiredState.set({ teamId, desiredState, reason });
  }

  private async stopAllRuntimes(): Promise<void> {
    for (const [teamId, runtime] of [...this.runtimes]) {
      await runtime.stop();
      this.lastStatuses.set(teamId, runtime.status());
      await this.releaseRuntimeLease(teamId);
    }
    this.runtimes.clear();
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
