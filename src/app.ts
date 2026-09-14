import { validateRuntimeConfig, env } from "./config/env.js";
import { closePool, getPool } from "./db/client.js";
import { MySqlGate6ControlRepository } from "./repositories/mysql-gate6-control-repository.js";
import { setTeamRuntimeActions } from "./controllers/teams-controller.js";
import {
  listTeamRuntimeDesiredStates,
  setTeamRuntimeDesiredState,
} from "./repositories/runtime-repository.js";
import { ensureDefaultTeamFromLegacySettings } from "./repositories/team-repository.js";
import { createAdminUserIfNotExists } from "./repositories/user-repository.js";
import { startHttpServer, stopHttpServer } from "./services/http-server.js";
import { handleRecoverableLineJsListenerRejection } from "./services/line-bot.js";
import { startLineImageListenerForRole } from "./services/line-image-listener-runtime.js";
import {
  startNotificationDispatchLoop,
  type NotificationDispatchLoop,
} from "./services/notification-dispatcher.js";
import { createNotificationLineSender } from "./services/notification-line-sender.js";
import { configureNotifyRulesRealtime, migrateJsonToDb } from "./services/notify-rules.js";
import { loadConfiguredRuntimeStatus } from "./services/runtime-status-loader.js";
import type { RealtimeScope } from "./services/realtime-contract.js";
import { roleRunsHttp, roleRunsNotifier, roleUsesDatabase } from "./services/runtime-role.js";
import { buildRuntimeStartupPlan } from "./services/runtime-startup-plan.js";
import { loadDbFirstSettingsIntoEnv } from "./services/settings.js";
import {
  createRoleAwareTeamRuntimeActions,
  createDistributedTeamRuntimeActions,
} from "./services/team-runtime-actions.js";
import { TeamRuntimeManager } from "./services/team-runtime-manager.js";
import { getSpxDispatcher } from "./utils/http-dispatcher.js";
import {
  startRuntimeNodeHeartbeat,
  type DedicatedRuntimeNodeRole,
  type RuntimeNodeHeartbeatHandle,
  type RuntimeNodeLoopMode,
} from "./services/runtime-node-heartbeat.js";
import { loadRuntimeReleaseIdentity } from "./services/runtime-release-identity.js";
import { createRealtimeServiceClient } from "./services/realtime-service-client.js";
import { createRuntimeRealtimePublisher } from "./services/realtime-publisher.js";
import { acquireRealtimeServiceSingletonLease } from "./services/realtime-service-singleton-lease.js";
import { startAutoAcceptJobDryRunWorkerLoop } from "./services/auto-accept-job-dry-run-loop.js";
import { startAutoAcceptJobRealWorkerLoop } from "./services/auto-accept-job-real-execution-loop.js";
import { startAutoAcceptJobSettlementWorkerLoop } from "./services/auto-accept-job-settlement-loop.js";

function parseIntervalArg(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const intervalSec = Number(value);
  if (!Number.isInteger(intervalSec) || intervalSec <= 0) {
    throw new Error("CLI polling interval must be a positive integer number of seconds");
  }

  return intervalSec;
}

function readPositiveIntEnv(name: string, defaultValue: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function canUseSettingsDatabase(): boolean {
  return (
    env.DB_MODE === "memory" ||
    Boolean(env.DB_HOST && env.DB_USERNAME && env.DB_PASSWORD && env.DB_NAME)
  );
}

function installShutdownHandlers(
  manager: TeamRuntimeManager | null,
  shouldStopHttp: () => boolean,
  stopBackgroundLoops: () => void | Promise<void>,
): void {
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Start a watchdog timer to force exit if graceful shutdown hangs (e.g. active SSE streams)
    const watchdog = setTimeout(() => {
      console.error("Graceful shutdown timed out, force exiting...");
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, 10000);
    watchdog.unref();

    try {
      await stopBackgroundLoops();
      await manager?.stopAll();
      if (shouldStopHttp()) await stopHttpServer();
      await getSpxDispatcher().close();
      await closePool();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      clearTimeout(watchdog);
    }
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (handleRecoverableLineJsListenerRejection(reason)) return;
    console.error(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
    void shutdown(1);
  });
}

async function main(): Promise<void> {
  const intervalSec = parseIntervalArg(process.argv[2]);
  let httpStarted = false;
  let notificationLoop: NotificationDispatchLoop | null = null;
  let stopDesiredStateLoop: (() => void) | null = null;
  let runtimeNodeHeartbeat: RuntimeNodeHeartbeatHandle | null = null;
  let realtimeSingletonLease: Awaited<ReturnType<typeof acquireRealtimeServiceSingletonLease>> | null = null;
  let autoAcceptDryRunWorkerLoop: ReturnType<typeof startAutoAcceptJobDryRunWorkerLoop> | null = null;
  let autoAcceptRealWorkerLoop: ReturnType<typeof startAutoAcceptJobRealWorkerLoop> | null = null;
  let autoAcceptSettlementWorkerLoop: ReturnType<typeof startAutoAcceptJobSettlementWorkerLoop> | null = null;

  // gate6-control owns only its four-table control-plane grant and must never
  // load DB-backed application settings with the application's credentials.
  if (env.SPX_ROLE !== "gate6-control" && roleUsesDatabase(env.SPX_ROLE) && canUseSettingsDatabase()) {
    await loadDbFirstSettingsIntoEnv();
  }

  validateRuntimeConfig();

  const startupPlan = buildRuntimeStartupPlan({
    role: env.SPX_ROLE,
    runTeamIds: env.RUN_TEAM_IDS,
    dryRunWorkerEnabled: env.AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED,
    realWorkerEnabled: env.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED,
    settlementWorkerEnabled: env.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED,
  });

  const runLegacyDataBootstrap = roleUsesDatabase(env.SPX_ROLE) && (env.SPX_ROLE === "api" || env.SPX_ROLE === "notifier");

  if (runLegacyDataBootstrap && (env.HTTP_ENABLED || env.SAVE_TO_DB || env.AUTO_ACCEPT_ENABLED)) {
    await migrateJsonToDb();
  }

  if (runLegacyDataBootstrap && canUseSettingsDatabase()) {
    await ensureDefaultTeamFromLegacySettings();
  }

  if (env.HTTP_ENABLED && startupPlan.httpSurface === "web-api") {
    await createAdminUserIfNotExists(env.ADMIN_USERNAME, env.ADMIN_PASSWORD, env.ADMIN_ROLE);
  }

  const runtimeReleaseIdentity = env.NODE_ENV === "production" ? loadRuntimeReleaseIdentity() : undefined;
  const runtimeStartedAt = new Date().toISOString();

  const runtimeRealtimePublisher = createRuntimeRealtimePublisher(env.REALTIME_SERVICE_URL ? {
    url: `${env.REALTIME_SERVICE_URL}/events`,
    sharedSecret: env.REALTIME_SHARED_SECRET,
    nodeId: env.SPX_NODE_ID,
    requestTimeoutMs: env.REALTIME_REQUEST_TIMEOUT_MS,
  } : undefined);
  const realtimeServiceClient = env.REALTIME_SERVICE_URL
    ? createRealtimeServiceClient({
        baseUrl: env.REALTIME_SERVICE_URL,
        sharedSecret: env.REALTIME_SHARED_SECRET,
        nodeId: env.SPX_NODE_ID,
        connectTimeoutMs: env.REALTIME_REQUEST_TIMEOUT_MS,
      })
    : undefined;
  configureNotifyRulesRealtime({
    publisher: runtimeRealtimePublisher,
    source: { service: startupPlan.httpSurface === "web-api" ? "web-api" : "worker", nodeId: env.SPX_NODE_ID || env.SPX_ROLE, role: env.SPX_ROLE },
  });

  const manager = startupPlan.runTeamRuntimeManager
    ? new TeamRuntimeManager({
        intervalSec,
        assignedTeamIds: startupPlan.pollerAssignedTeamIds,
        realtimePublisher: runtimeRealtimePublisher,
        publishTeamRuntimeMetrics: env.SPX_ROLE === "notifier" || env.SPX_ROLE === "combined",
        lease: startupPlan.runTeamRuntimeLease
          ? {
              nodeId: env.SPX_NODE_ID || "combined-worker",
              role: env.SPX_ROLE,
              ttlMs: 30_000,
              renewIntervalMs: 10_000,
              releaseIdentity: runtimeReleaseIdentity,
              startedAt: runtimeStartedAt,
            }
          : undefined,
        desiredState: startupPlan.runDesiredStateLoop
          ? {
              intervalMs: 1_000,
              list: listTeamRuntimeDesiredStates,
              set: setTeamRuntimeDesiredState,
            }
          : undefined,
      })
    : null;
  setTeamRuntimeActions(
    startupPlan.runDistributedTeamRuntimeActions
      ? createDistributedTeamRuntimeActions()
      : manager
        ? createRoleAwareTeamRuntimeActions(manager, startupPlan.runTeamRuntimeActions)
        : createDistributedTeamRuntimeActions(),
  );
  installShutdownHandlers(
    manager,
    () => httpStarted,
    async () => {
      notificationLoop?.stop();
      notificationLoop = null;
      stopDesiredStateLoop?.();
      stopDesiredStateLoop = null;
      runtimeNodeHeartbeat?.stop();
      autoAcceptDryRunWorkerLoop?.stop();
      autoAcceptDryRunWorkerLoop = null;
      autoAcceptRealWorkerLoop?.stop();
      autoAcceptRealWorkerLoop = null;
      autoAcceptSettlementWorkerLoop?.stop();
      autoAcceptSettlementWorkerLoop = null;
      await realtimeSingletonLease?.release();
    },
  );

  if (
    env.SPX_ROLE === "poller-service" ||
    env.SPX_ROLE === "auto-accept-service" ||
    env.SPX_ROLE === "line-service"
  ) {
    const heartbeatRuntimeRole: DedicatedRuntimeNodeRole | "line-service" = env.SPX_ROLE;
    let enabledRuntimeNodeLoopModes: RuntimeNodeLoopMode[] = [];
    if (heartbeatRuntimeRole === "poller-service") {
      enabledRuntimeNodeLoopModes = ["poller"];
    } else if (heartbeatRuntimeRole === "auto-accept-service") {
      if (startupPlan.runAutoAcceptDryRunLoop) enabledRuntimeNodeLoopModes.push("autoAcceptDryRun");
      if (startupPlan.runAutoAcceptRealLoop) enabledRuntimeNodeLoopModes.push("autoAcceptReal");
      if (startupPlan.runAutoAcceptSettlementLoop) enabledRuntimeNodeLoopModes.push("autoAcceptSettlement");
    }
    runtimeNodeHeartbeat = await startRuntimeNodeHeartbeat({
      nodeId: env.SPX_NODE_ID || heartbeatRuntimeRole,
      role: heartbeatRuntimeRole,
      assignedTeamIds: heartbeatRuntimeRole === "line-service" ? [] : env.RUN_TEAM_IDS,
      enabledLoopModes: enabledRuntimeNodeLoopModes,
      intervalMs: 10_000,
      releaseIdentity: runtimeReleaseIdentity,
      startedAt: runtimeStartedAt,
    });
  }

  const runtimeRealtimePublisherForHttp = runtimeRealtimePublisher;
  const realtimeReadGateway = realtimeServiceClient;

  if (env.SPX_ROLE === "realtime-service") {
    realtimeSingletonLease = await acquireRealtimeServiceSingletonLease();
  }
  const gate6Pool = env.SPX_ROLE === "gate6-control" ? getPool() : null;
  if (env.SPX_ROLE === "gate6-control" && !gate6Pool) throw new Error("gate6-control requires durable MySQL storage");

  if (env.HTTP_ENABLED && startupPlan.runHttp && roleRunsHttp(env.SPX_ROLE)) {
    await startHttpServer(env.HTTP_PORT, {
      surface: startupPlan.httpSurface ?? "web-api",
      role: env.SPX_ROLE,
      realtimeReadGateway,
      runtimeMetricsRealtimePublisher: runtimeRealtimePublisherForHttp,
      loadRealtimeRuntimeStatus: (scope) => loadConfiguredRuntimeStatus(scope as RealtimeScope),
      gate6Repository: gate6Pool ? new MySqlGate6ControlRepository({
        async getConnection() {
          const connection = await gate6Pool.getConnection();
          return {
            beginTransaction: () => connection.beginTransaction(),
            commit: () => connection.commit(),
            rollback: () => connection.rollback(),
            release: () => connection.release(),
            execute: (statement, parameters) => connection.execute(statement, (parameters ? [...parameters] : []) as Parameters<typeof connection.execute>[1]),
          };
        },
      }) : undefined,
    });
    httpStarted = true;
  }

  if (roleRunsNotifier(env.SPX_ROLE)) {
    const notifierNodeId = env.SPX_NODE_ID || "combined-notifier";
    notificationLoop = startNotificationDispatchLoop({
      nodeId: notifierNodeId,
      batchSize: 10,
      lockMs: 30_000,
      intervalMs: 1_000,
      sendLineMessage: createNotificationLineSender({
        lineServiceUrl: env.LINE_SERVICE_URL,
        sharedSecret: env.LINE_SERVICE_SEND_SECRET || env.NOTIFIER_SHARED_SECRET,
        nodeId: notifierNodeId,
        requestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
        allowLocalFallback: env.SPX_ROLE === "notifier" || env.SPX_ROLE === "combined",
      }),
    });
  }

  await startLineImageListenerForRole({
    role: env.SPX_ROLE,
    nodeId: env.SPX_NODE_ID || "combined-line-service",
    chatId: env.LINE_IMAGE_LISTENER_CHAT_ID,
  });

  const workerNodeId = env.SPX_NODE_ID || "combined-worker";
  if (startupPlan.runAutoAcceptDryRunLoop) {
    autoAcceptDryRunWorkerLoop = startAutoAcceptJobDryRunWorkerLoop({
      nodeId: workerNodeId,
      teamIds: startupPlan.autoAcceptTeamIds,
      batchSize: readPositiveIntEnv("AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE", 10),
      leaseMs: readPositiveIntEnv("AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS", 300_000),
      intervalMs: readPositiveIntEnv("AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS", 1_000),
    });
  }
  if (startupPlan.runAutoAcceptRealLoop) {
    autoAcceptRealWorkerLoop = startAutoAcceptJobRealWorkerLoop({
      realtimePublisher: runtimeRealtimePublisher,
      metricsPublication: startupPlan.executionMetricsPublication,
      nodeId: workerNodeId,
      teamIds: startupPlan.autoAcceptTeamIds,
      batchSize: readPositiveIntEnv("AUTO_ACCEPT_JOB_REAL_BATCH_SIZE", 10),
      leaseMs: readPositiveIntEnv("AUTO_ACCEPT_JOB_REAL_LEASE_MS", 300_000),
      intervalMs: readPositiveIntEnv("AUTO_ACCEPT_JOB_REAL_INTERVAL_MS", 1_000),
    });
  }
  if (startupPlan.runAutoAcceptSettlementLoop) {
    autoAcceptSettlementWorkerLoop = startAutoAcceptJobSettlementWorkerLoop({
      nodeId: workerNodeId,
      teamIds: startupPlan.autoAcceptTeamIds,
      batchSize: readPositiveIntEnv("AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE", 10),
      leaseMs: readPositiveIntEnv("AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS", 300_000),
      intervalMs: readPositiveIntEnv("AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS", 1_000),
    });
  }
  if (manager && startupPlan.runTeamRuntimeManager) {
    await manager.startAllEnabledTeams();
    const loop = manager.startDesiredStateLoop();
    stopDesiredStateLoop = () => loop.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
