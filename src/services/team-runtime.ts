import { teamMetricsCollector } from "./metrics.js";
import { ApiClient } from "./api-client.js";
import { env, resolveTeamPollIntervalMs } from "../config/env.js";
import { Poller } from "../controllers/poller.js";
import type { TeamPollerContext } from "../controllers/poller.js";
import type { TeamRuntimeConfig } from "../repositories/team-repository.js";
import type { RealtimePublisher, RealtimeSource } from "./realtime-contract.js";
import { isTeamPaused, pauseTeam, resumeTeam } from "./poller-control.js";
import { acquireLiveSettingsSync, reloadSettingsLive } from "./settings.js";
import { createTeamRuntimeSession, type TeamRuntimeSession } from "./provider-auth/runtime-session.js";
import { TeamCredentialPool, getOrCreateTeamCredentialPool } from "./team-credential-pool.js";
import { TeamDriverPool, getOrCreateTeamDriverPool } from "./team-driver-pool.js";

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

const DEFAULT_LIVE_SETTINGS_SYNC_INTERVAL_MS = 5_000;

export interface TeamRuntimeOptions {
  intervalSec?: number;
  realtimePublisher?: RealtimePublisher;
  realtimeSource?: RealtimeSource;
  liveSettingsSyncIntervalMs?: number;
}

export class TeamRuntime implements TeamRuntimeHandle {
  public readonly teamId: number;
  private readonly teamName: string;
  private readonly config: TeamRuntimeConfig;
  private readonly intervalSec: number | undefined;
  private readonly realtimePublisher: RealtimePublisher | undefined;
  private readonly realtimeSource: RealtimeSource | undefined;
  private readonly liveSettingsSyncIntervalMs: number | undefined;
  private poller: Poller | null = null;
  private providerSession: TeamRuntimeSession | null = null;
  private credentialPool: TeamCredentialPool | null = null;
  private driverPool: TeamDriverPool | null = null;
  private lastAccountReloadAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  private releaseLiveSettingsSync: (() => Promise<void>) | null = null;
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
    this.liveSettingsSyncIntervalMs = options.liveSettingsSyncIntervalMs;
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
    this.driverPool = env.SPX_ROLE === "poller-service"
      ? null
      : await getOrCreateTeamDriverPool(this.teamId);
    this.lastAccountReloadAt = Date.now();

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
        pollIntervalMsProvider: () =>
          resolveTeamPollIntervalMs(
            this.teamId,
            this.intervalSec !== undefined ? this.intervalSec * 1000 : null,
          ),
        biddingVehicleType: this.config.biddingVehicleType,
        driverResolver: (input) => this.driverPool?.nextDriver(input) ?? null,
        hasAutoDrivers: () => this.driverPool?.hasDrivers() ?? false,
        onDriverAcceptError: (driverId) => {
          this.driverPool?.recordDriverFailure(driverId);
        },
        onDriverAcceptReleased: (bookingId, driverId, driverName) => {
          this.driverPool?.releaseBookingDriver(bookingId, driverId, driverName);
        },
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
          this.triggerBackgroundRefresh();
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
      this.startLiveSettingsSync();
      this.statusValue = isTeamPaused(this.teamId) ? "paused" : "running";
      this.lastPollAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      await this.stopLiveSettingsSync();
      this.providerSession?.dispose();
      this.providerSession = null;
      this.credentialPool = null;
      this.statusValue = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private startLiveSettingsSync(): void {
    if (this.releaseLiveSettingsSync) return;
    const syncIntervalMs =
      this.liveSettingsSyncIntervalMs !== undefined
        ? this.liveSettingsSyncIntervalMs
        : process.env.NODE_ENV === "test"
          ? 0
          : DEFAULT_LIVE_SETTINGS_SYNC_INTERVAL_MS;
    if (!Number.isFinite(syncIntervalMs) || syncIntervalMs <= 0) return;

    this.releaseLiveSettingsSync = acquireLiveSettingsSync(syncIntervalMs);
  }

  private async stopLiveSettingsSync(): Promise<void> {
    const release = this.releaseLiveSettingsSync;
    this.releaseLiveSettingsSync = null;
    if (release) {
      await release();
    }
  }

  private triggerBackgroundRefresh(): void {
    const now = Date.now();
    if (now - this.lastAccountReloadAt <= 30_000 || this.refreshInFlight) {
      return;
    }
    this.lastAccountReloadAt = now;
    const pool = this.credentialPool;
    const drivers = this.driverPool;
    this.refreshInFlight = Promise.all([
      pool ? pool.reloadAccounts() : Promise.resolve(),
      drivers ? drivers.reloadDrivers() : Promise.resolve(),
      !this.releaseLiveSettingsSync && process.env.NODE_ENV === "production"
        ? reloadSettingsLive().catch(() => undefined)
        : Promise.resolve(),
    ])
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.refreshInFlight = null;
      });
  }

  async stop(): Promise<void> {
    if (this.poller) {
      await this.poller.stop(0);
      this.poller = null;
    }
    await this.stopLiveSettingsSync();
    if (this.refreshInFlight) {
      await this.refreshInFlight;
    }
    this.providerSession?.dispose();
    this.providerSession = null;
    this.credentialPool = null;
    this.driverPool = null;
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
