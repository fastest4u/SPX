import { validateRuntimeConfig, env } from "./config/env.js";
import { Poller } from "./controllers/poller.js";
import { createAdminUserIfNotExists } from "./repositories/user-repository.js";
import { migrateJsonToDb } from "./services/notify-rules.js";
import { loadDbSettingsIntoEnv, migrateEnvSettingsToDb } from "./services/settings.js";

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

  if (env.HTTP_ENABLED) {
    await createAdminUserIfNotExists(env.ADMIN_USERNAME, env.ADMIN_PASSWORD, env.ADMIN_ROLE);
  }

  const poller = new Poller(intervalSec);
  await poller.start();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
