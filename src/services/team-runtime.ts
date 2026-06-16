import { ApiClient } from "./api-client.js";
import { env } from "../config/env.js";
import { Poller } from "../controllers/poller.js";
import type { TeamPollerContext } from "../controllers/poller.js";
import type { TeamRuntimeConfig } from "../repositories/team-repository.js";
import { isTeamPaused, pauseTeam, resumeTeam } from "./poller-control.js";

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
}

export class TeamRuntime implements TeamRuntimeHandle {
  public readonly teamId: number;
  private readonly teamName: string;
  private readonly config: TeamRuntimeConfig;
  private readonly intervalSec: number | undefined;
  private poller: Poller | null = null;
  private statusValue: TeamRuntimeStatusValue = "stopped";
  private lastPollAt: string | null = null;
  private lastError: string | null = null;

  constructor(config: TeamRuntimeConfig, options: TeamRuntimeOptions = {}) {
    this.config = config;
    this.teamId = config.id;
    this.teamName = config.name;
    this.intervalSec = options.intervalSec;
  }

  async start(): Promise<void> {
    if (this.statusValue === "running" || this.statusValue === "paused") return;
    if (!this.config.spxCookie || !this.config.spxDeviceId) {
      this.statusValue = "misconfigured";
      this.lastError = "Team SPX credentials are incomplete";
      return;
    }

    try {
      const apiClient = new ApiClient({
        credentials: {
          spxCookie: this.config.spxCookie,
          spxDeviceId: this.config.spxDeviceId,
        },
        pollIntervalMsProvider: () => this.intervalSec !== undefined ? this.intervalSec * 1000 : env.POLL_INTERVAL_MS,
      });
      const context: TeamPollerContext = {
        teamId: this.config.id,
        teamName: this.config.name,
        apiClient,
        lineGroupId: this.config.lineGroupId,
        manageHttpServer: false,
        manageProcessSignals: false,
        closeSharedResourcesOnStop: false,
        exitOnStop: false,
      };
      this.poller = new Poller(this.intervalSec, context);
      await this.poller.start();
      this.statusValue = isTeamPaused(this.teamId) ? "paused" : "running";
      this.lastPollAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.statusValue = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
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
