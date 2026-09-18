import { teamMetricsCollector } from "./metrics.js";
import { ApiClient } from "./api-client.js";
import { env } from "../config/env.js";
import { Poller } from "../controllers/poller.js";
import type { TeamPollerContext } from "../controllers/poller.js";
import type { TeamRuntimeConfig } from "../repositories/team-repository.js";
import type { RealtimePublisher, RealtimeSource } from "./realtime-contract.js";
import { isTeamPaused, pauseTeam, resumeTeam } from "./poller-control.js";
import { createTeamRuntimeSession, type TeamRuntimeSession } from "./provider-auth/runtime-session.js";
import { TeamCredentialPool, getOrCreateTeamCredentialPool } from "./team-credential-pool.js";

export type TeamRuntimeStatusValue = "stopped" | "running" | "paused" | "misconfigured" | "session_expired" | "error";

export interface TeamRuntimeStatus {
  teamId: number;
  teamName: string;
  status: TeamRuntimeStatusValue;
  lastPollAt: string | null;
  lastError: string | null;
}

export interface TeamRuntimeHandle {
  teamId: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  status(): TeamRuntimeStatus;
}

export interface TeamRuntimeOptions {
  intervalSec?: number;
  realtimePublisher?: RealtimePublisher;
  realtimeSource?: RealtimeSource;
}

export class TeamRuntime implements TeamRuntimeHandle {
  public readonly teamId: number;
  private readonly teamName: string;
  private readonly config: TeamRuntimeConfig;
  private readonly intervalSec: number | undefined;
  private readonly realtimePublisher: RealtimePublisher | undefined;
  private readonly realtimeSource: RealtimeSource | undefined;
  private poller: Poller | null = null;
  private providerSession: TeamRuntimeSession | null = null;
  private credentialPool: TeamCredentialPool | null = null;
  private lastAccountReloadAt = 0;
  private statusValue: TeamRuntimeStatusValue = "stopped";
  private lastPollAt: string | null = null;
  private lastError: string | null = null;

  constructor(config: TeamRuntimeConfig, options: TeamRuntimeOptions = {}) {
    this.config = config;
    this.teamId = config.id;
    this.teamName = config.name;
    this.intervalSec = options.intervalSec;
    this.realtimePublisher = options.realtimePublisher;
    this.realtimeSource = options.realtimeSource;
  }

  getCredentialPool(): TeamCredentialPool | null {
    return this.credentialPool;
  }

  async start(): Promise<void> {
    if (this.statusValue === "running" || this.statusValue === "paused") return;

    const fallbackCredentials = (this.config.spxCookie && this.config.spxDeviceId)
      ? { spxCookie: this.config.spxCookie, spxDeviceId: this.config.spxDeviceId }
      : null;

    this.credentialPool = await getOrCreateTeamCredentialPool(this.teamId, fallbackCredentials);

    if (!this.credentialPool.hasCredentials()) {
      this.statusValue = "misconfigured";
      this.lastError = "Team SPX credentials are incomplete";
      return;
    }

    try {
      if (fallbackCredentials) {
        this.providerSession = createTeamRuntimeSession(this.config.id, fallbackCredentials);
      }
      const metricsCollector = teamMetricsCollector(this.teamId, this.teamName);
      const apiClient = new ApiClient({
        metricsCollector,
        credentialsProvider: () => {
          if (this.credentialPool && this.credentialPool.getAccountCount() > 0) {
            return this.credentialPool.nextCredentials();
          }
          return this.providerSession ? this.providerSession.credentials() : this.credentialPool!.nextCredentials();
        },
        onRateLimit: (accountId, retryAfterMs) => {
          this.credentialPool?.recordRateLimit(accountId, retryAfterMs);
        },
        onSessionExpired: (accountId) => {
          this.credentialPool?.recordSessionExpired(accountId);
        },
        pollIntervalMsProvider: () => this.intervalSec !== undefined ? this.intervalSec * 1000 : env.POLL_INTERVAL_MS,
        biddingVehicleType: this.config.biddingVehicleType,
      });
      const context: TeamPollerContext = {
        metricsCollector,
        teamId: this.config.id,
        teamName: this.config.name,
        apiClient,
        lineGroupId: this.config.lineGroupId,
        rateLimitNotifyEnabled: this.config.rateLimitNotifyEnabled,
        manageHttpServer: false,
        manageProcessSignals: false,
        closeSharedResourcesOnStop: false,
        exitOnStop: false,
        biddingVehicleType: this.config.biddingVehicleType,
        beforePoll: async () => {
          const now = Date.now();
          if (now - this.lastAccountReloadAt > 30_000) {
            this.lastAccountReloadAt = now;
            await this.credentialPool?.reloadAccounts();
          }
          return this.providerSession ? this.providerSession.beforePoll() : true;
        },
        onSessionRejected: async () => {
          if (this.providerSession) {
            return await this.providerSession.recover();
          }
          if (this.credentialPool && this.credentialPool.getAccountCount() > 0) {
            return this.credentialPool.getActiveAccountCount() > 0;
          }
          return false;
        },
        realtimePublisher: this.realtimePublisher,
        realtimeSource: this.realtimeSource,
      };
      this.poller = new Poller(this.intervalSec, context);
      await this.poller.start();
      this.statusValue = isTeamPaused(this.teamId) ? "paused" : "running";
      this.lastPollAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.providerSession?.dispose();
      this.providerSession = null;
      this.credentialPool = null;
      this.statusValue = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.providerSession?.dispose();
    this.providerSession = null;
    this.credentialPool = null;
    if (this.poller) {
      await this.poller.stop(0);
      this.poller = null;
    }
    this.statusValue = "stopped";
  }

  pause(): void {
    pauseTeam(this.teamId);
    if (this.statusValue === "running") this.statusValue = "paused";
  }

  resume(): void {
    resumeTeam(this.teamId);
    if (this.statusValue === "paused") this.statusValue = "running";
  }

  status(): TeamRuntimeStatus {
    return {
      teamId: this.teamId,
      teamName: this.teamName,
      status: this.statusValue,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    };
  }
}
