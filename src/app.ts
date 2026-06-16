import { validateRuntimeConfig, env } from "./config/env.js";
import { closePool } from "./db/client.js";
import { setTeamRuntimeActions } from "./controllers/teams-controller.js";
import { ensureDefaultTeamFromLegacySettings } from "./repositories/team-repository.js";
import { createAdminUserIfNotExists } from "./repositories/user-repository.js";
import { startHttpServer, stopHttpServer } from "./services/http-server.js";
import { migrateJsonToDb } from "./services/notify-rules.js";
import { loadDbSettingsIntoEnv, migrateEnvSettingsToDb } from "./services/settings.js";
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
  const usesDatabase = env.HTTP_ENABLED || env.SAVE_TO_DB || env.AUTO_ACCEPT_ENABLED;
  return usesDatabase && (env.DB_MODE === "memory" || Boolean(env.DB_HOST && env.DB_USERNAME && env.DB_PASSWORD && env.DB_NAME));
}

function installShutdownHandlers(manager: TeamRuntimeManager): void {
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await manager.stopAll();
      if (env.HTTP_ENABLED) await stopHttpServer();
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
    console.error(error instanceof Error ? error.message : String(error));
    void shutdown(1);
  });
  process.once("unhandledRejection", (reason) => {
    console.error(reason instanceof Error ? reason.message : String(reason));
    void shutdown(1);
  });
}

async function main(): Promise<void> {
  const intervalSec = parseIntervalArg(process.argv[2]);

  if (canUseSettingsDatabase()) {
    await migrateEnvSettingsToDb();
    await loadDbSettingsIntoEnv();
  }

  validateRuntimeConfig();

  if (env.HTTP_ENABLED || env.SAVE_TO_DB || env.AUTO_ACCEPT_ENABLED) {
    await migrateJsonToDb();
  }

  if (canUseSettingsDatabase()) {
    await ensureDefaultTeamFromLegacySettings();
  }

  if (env.HTTP_ENABLED) {
    await createAdminUserIfNotExists(env.ADMIN_USERNAME, env.ADMIN_PASSWORD, env.ADMIN_ROLE);
  }

  const runtimeManager = new TeamRuntimeManager({ intervalSec });
  setTeamRuntimeActions({
    restartTeam: (teamId) => runtimeManager.restartTeam(teamId),
    pauseTeam: (teamId) => runtimeManager.pauseTeam(teamId),
    resumeTeam: (teamId) => runtimeManager.resumeTeam(teamId),
    stopTeam: (teamId) => runtimeManager.stopTeam(teamId),
    restartAll: () => runtimeManager.restartAll(),
    getStatus: (teamId) => runtimeManager.getStatus(teamId),
  });
  installShutdownHandlers(runtimeManager);

  if (env.HTTP_ENABLED) {
    await startHttpServer(env.HTTP_PORT);
  }

  await runtimeManager.startAllEnabledTeams();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
