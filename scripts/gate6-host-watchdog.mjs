#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { readGate6RuntimeContext } from "./lib/gate6-runtime-context.mjs";
import {
  gate6InstanceUnit,
  parseGate6InstanceArguments,
  verifyGate6SupervisorInstall,
} from "./lib/gate6-immutable-runtime.mjs";
import {
  createGate6MysqlLedger,
  createProductionGate6MysqlPool,
} from "./lib/gate6-mysql-ledger.mjs";

export const WATCHDOG_SERVICE_ALLOWLIST = Object.freeze([
  "gate6-monitor",
  "gate6-rollback-supervisor",
]);
const SYSTEMD_UNIT_KINDS = Object.freeze({
  "gate6-monitor": "monitor",
  "gate6-rollback-supervisor": "rollback-supervisor",
});
const ACTIVE_RUN_STATES = new Set(["active", "sealed-verifying", "releasing"]);

export async function reconcileGate6HostWatchdog({ run, liveness, restart, convergeRollback }) {
  for (const service of Object.keys(liveness ?? {})) {
    if (!WATCHDOG_SERVICE_ALLOWLIST.includes(service)) throw new Error("unknown watchdog service");
  }
  for (const service of WATCHDOG_SERVICE_ALLOWLIST) {
    if (liveness?.[service] !== true) await restart(service);
  }
  if (run?.status === "revoked") await convergeRollback();
  return { status: run?.status ?? "unknown" };
}

function runSystemctl(args, spawnImpl = spawn) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl("/usr/bin/systemctl", args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise(code === 0 && signal === null));
  });
}

export function createGate6SystemdServiceManager(options = {}) {
  const instance = options.instance;
  const unit = (service) => gate6InstanceUnit(SYSTEMD_UNIT_KINDS[service], instance, options.context);
  return Object.freeze({
    async isActive(service) {
      if (!WATCHDOG_SERVICE_ALLOWLIST.includes(service)) throw new Error("unknown watchdog service");
      return runSystemctl(["is-active", "--quiet", unit(service)], options.spawnImpl);
    },
    async restart(service) {
      if (!WATCHDOG_SERVICE_ALLOWLIST.includes(service)) throw new Error("unknown watchdog service");
      if (!await runSystemctl(["restart", unit(service)], options.spawnImpl)) {
        throw new Error(`Gate 6 watchdog could not restart ${service}`);
      }
    },
  });
}

export function restartGate6ControlService(service, instance, spawnImpl = spawn) {
  if (!WATCHDOG_SERVICE_ALLOWLIST.includes(service)) throw new Error("unknown watchdog service");
  return spawnImpl("/usr/bin/systemctl", ["restart", gate6InstanceUnit(SYSTEMD_UNIT_KINDS[service], instance)], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
}

export async function superviseGate6HostOnce(input) {
  const ttlMs = input.ttlMs ?? 15_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 30_000) {
    throw new Error("Gate 6 supervisor lease TTL is invalid");
  }
  const now = input.now ?? new Date();
  const run = await input.ledger.getSupervisorState(input.context.gate6Id);
  if (run.status === "released") return { status: "released", servicesHealthy: true };
  if (!ACTIVE_RUN_STATES.has(run.status) && run.status !== "revoked") {
    throw new Error("Gate 6 supervisor run state is invalid");
  }
  const liveness = {};
  for (const service of WATCHDOG_SERVICE_ALLOWLIST) {
    liveness[service] = await input.services.isActive(service);
    if (!liveness[service]) {
      await input.services.restart(service);
      liveness[service] = await input.services.isActive(service);
    }
  }
  const servicesHealthy = WATCHDOG_SERVICE_ALLOWLIST.every((service) => liveness[service] === true);
  if (ACTIVE_RUN_STATES.has(run.status)) {
    await input.ledger.renewLease({
      gate6Id: input.context.gate6Id,
      lease: "supervisor",
      status: servicesHealthy ? "green" : "red",
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      now,
    });
  }
  if (!servicesHealthy) throw new Error("Gate 6 control service liveness is red");
  return { status: run.status, servicesHealthy };
}

export async function runGate6HostWatchdogLoop(input) {
  const intervalMs = input.intervalMs ?? 5_000;
  const ttlMs = input.ttlMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs * 2 >= ttlMs) {
    throw new Error("Gate 6 supervisor interval is invalid");
  }
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopped) {
      const result = await superviseGate6HostOnce({ ...input, ttlMs, now: new Date() });
      if (result.status === "released") return result;
      await (input.sleep ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))))(intervalMs);
    }
    return { status: "stopped", servicesHealthy: false };
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

async function main() {
  let pool;
  try {
    const instance = parseGate6InstanceArguments(process.argv.slice(2), "--supervise");
    const context = await readGate6RuntimeContext();
    await verifyGate6SupervisorInstall({ instance, context });
    pool = await createProductionGate6MysqlPool({
      runtime: "host",
      expectedTargetDescriptorSha256: context.targetDescriptorSha256,
    });
    const result = await runGate6HostWatchdogLoop({
      context,
      ledger: createGate6MysqlLedger(pool),
      services: createGate6SystemdServiceManager({ instance, context }),
    });
    process.stdout.write(`${canonicalGate6Json({ ok: result.status === "released", status: result.status })}\n`);
    if (result.status !== "released") process.exitCode = 1;
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-watchdog-refused" })}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
