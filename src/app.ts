import { validateRuntimeConfig, env } from "./config/env.js";
import { Poller } from "./controllers/poller.js";
import { createAdminUserIfNotExists } from "./repositories/user-repository.js";

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

async function main(): Promise<void> {
  const intervalSec = parseIntervalArg(process.argv[2]);

  validateRuntimeConfig();

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
