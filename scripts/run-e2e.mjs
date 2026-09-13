import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runE2e } from "./e2e-runner.mjs";
process.exitCode = runE2e(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
