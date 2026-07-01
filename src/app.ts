import { validateRuntimeConfig, env } from "./config/env.js";
import { closePool } from "./db/client.js";
import { setTeamRuntimeActions } from "./controllers/teams-controller.js";
import { listTeamRuntimeDesiredStates, setTeamRuntimeDesiredState } from "./repositories/runtime-repository.js";
import { ensureDefaultTeamFromLegacySettings } from "./repositories/team-repository.js";
import { createAdminUserIfNotExists } from "./repositories/user-repository.js";
import { startHttpServer, stopHttpServer } from "./services/http-server.js";
import { handleRecoverableLineJsListenerRejection } from "./services/line-bot.js";
import { startNotificationDispatchLoop, type NotificationDispatchLoop } from "./services/notification-dispatcher.js";
import { sendLineTargetMessage } from "./services/notifier.js";
import { migrateJsonToDb } from "./services/notify-rules.js";
import { roleRunsHttp, roleRunsNotifier, roleRunsWorkers } from "./services/runtime-role.js";
import { loadDbFirstSettingsIntoEnv } from "./services/settings.js";
import { createRoleAwareTeamRuntimeActions } from "./services/team-runtime-actions.js";
import { TeamRuntimeManager } from "./services/team-runtime-manager.js";
import { getSpxDispatcher } from "./utils/http-dispatcher.js";

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

function canUseSettingsDatabase(): boolean {
  return env.DB_MODE === "memory" || Boolean(env.DB_HOST && env.DB_USERNAME && env.DB_PASSWORD && env.DB_NAME);
}

function installShutdownHandlers(
  manager: TeamRuntimeManager,
  shouldStopHttp: () => boolean,
  stopBackgroundLoops: () => void,
): void {
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      stopBackgroundLoops();
      await manager.stopAll();
      if (shouldStopHttp()) await stopHttpServer();
      await getSpxDispatcher().close();
      await closePool();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.once("uncaughtException", (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    if (handleRecoverableLineJsListenerRejection(reason)) return;
    console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
    void shutdown(1);
  });
}

async function main(): Promise<void> {
  const intervalSec = parseIntervalArg(process.argv[2]);
  let httpStarted = false;
  let notificationLoop: NotificationDispatchLoop | null = null;
  let stopDesiredStateLoop: (() => void) | null = null;

  if (canUseSettingsDatabase()) {
    await loadDbFirstSettingsIntoEnv();
  }

  validateRuntimeConfig();

  if (env.HTTP_ENABLED || env.SAVE_TO_DB || env.AUTO_ACCEPT_ENABLED) {
    await migrateJsonToDb();
  }

  if (canUseSettingsDatabase()) {
    await ensureDefaultTeamFromLegacySettings();
  }

  if (env.HTTP_ENABLED && roleRunsHttp(env.SPX_ROLE)) {
    await createAdminUserIfNotExists(env.ADMIN_USERNAME, env.ADMIN_PASSWORD, env.ADMIN_ROLE);
  }

  const runtimeManager = new TeamRuntimeManager({
    intervalSec,
    assignedTeamIds: env.SPX_ROLE === "worker" ? env.RUN_TEAM_IDS : undefined,
    lease: roleRunsWorkers(env.SPX_ROLE) ? {
      nodeId: env.SPX_NODE_ID || "combined-worker",
      role: env.SPX_ROLE,
      ttlMs: 30_000,
      renewIntervalMs: 10_000,
    } : undefined,
    desiredState: roleRunsWorkers(env.SPX_ROLE) ? {
      intervalMs: 1_000,
      list: listTeamRuntimeDesiredStates,
      set: setTeamRuntimeDesiredState,
    } : undefined,
  });
  const workerActionsEnabled = roleRunsWorkers(env.SPX_ROLE);
  setTeamRuntimeActions(createRoleAwareTeamRuntimeActions(runtimeManager, workerActionsEnabled));
  installShutdownHandlers(runtimeManager, () => httpStarted, () => {
    notificationLoop?.stop();
    notificationLoop = null;
    stopDesiredStateLoop?.();
    stopDesiredStateLoop = null;
  });

  if (env.HTTP_ENABLED && roleRunsHttp(env.SPX_ROLE)) {
    await startHttpServer(env.HTTP_PORT);
    httpStarted = true;
  }

  if (roleRunsNotifier(env.SPX_ROLE)) {
    notificationLoop = startNotificationDispatchLoop({
      nodeId: env.SPX_NODE_ID || "combined-notifier",
      batchSize: 10,
      lockMs: 30_000,
      intervalMs: 1_000,
      sendLineMessage: sendLineTargetMessage,
    });
  }

  if (roleRunsWorkers(env.SPX_ROLE)) {
    await runtimeManager.startAllEnabledTeams();
    const loop = runtimeManager.startDesiredStateLoop();
    stopDesiredStateLoop = () => loop.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
