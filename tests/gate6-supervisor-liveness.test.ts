import assert from "node:assert/strict";

import {
  WATCHDOG_SERVICE_ALLOWLIST,
  createGate6SystemdServiceManager,
  reconcileGate6HostWatchdog,
  superviseGate6HostOnce,
} from "../scripts/gate6-host-watchdog.mjs";

async function main(): Promise<void> {
  assert.deepEqual(WATCHDOG_SERVICE_ALLOWLIST, ["gate6-monitor", "gate6-rollback-supervisor"]);
  const restarted: string[] = [];
  let rollback = 0;
  await reconcileGate6HostWatchdog({
    run: { status: "revoked" },
    liveness: { "gate6-monitor": false, "gate6-rollback-supervisor": false },
    restart: async (service: string) => { restarted.push(service); },
    convergeRollback: async () => { rollback += 1; },
  });
  assert.deepEqual(restarted, WATCHDOG_SERVICE_ALLOWLIST);
  assert.equal(rollback, 1);

  const renewals: unknown[] = [];
  const active = new Map(WATCHDOG_SERVICE_ALLOWLIST.map((service) => [service, service === "gate6-monitor"]));
  const supervised = await superviseGate6HostOnce({
    context: { gate6Id: "gate6-prod-001" },
    ledger: {
      async getSupervisorState() { return { status: "active" }; },
      async renewLease(value: unknown) { renewals.push(value); },
    },
    services: {
      async isActive(service: string) { return active.get(service) === true; },
      async restart(service: string) { active.set(service, true); },
    },
    now: new Date("2026-07-11T01:00:00.000Z"),
    ttlMs: 15_000,
  });
  assert.deepEqual(supervised, { status: "active", servicesHealthy: true });
  assert.equal((renewals[0] as { status: string }).status, "green");

  const instance = "a".repeat(40);
  const systemctlArgs: string[][] = [];
  const spawnImpl = (_file: string, args: string[]) => {
    systemctlArgs.push(args);
    const listeners = new Map<string, (...values: unknown[]) => void>();
    queueMicrotask(() => listeners.get("close")?.(0, null));
    return { once(event: string, listener: (...values: unknown[]) => void) { listeners.set(event, listener); } };
  };
  const manager = createGate6SystemdServiceManager({ instance, spawnImpl });
  await manager.isActive("gate6-monitor");
  await manager.restart("gate6-rollback-supervisor");
  assert.deepEqual(systemctlArgs, [
    ["is-active", "--quiet", `spx-gate6-monitor@${instance}.service`],
    ["restart", `spx-gate6-rollback-supervisor@${instance}.service`],
  ]);

  await assert.rejects(
    () => reconcileGate6HostWatchdog({
      run: { status: "active" },
      liveness: { "web-service": false },
      restart: async () => {},
      convergeRollback: async () => {},
    }),
    /unknown watchdog service/i,
  );
  console.log("gate6 supervisor liveness tests passed");
}

void main();
