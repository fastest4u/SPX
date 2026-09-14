import assert from "node:assert/strict";

import { reconcileProtectedInstall } from "../scripts/protected-install-watchdog.mjs";

async function main(): Promise<void> {
  const restored: string[] = [];
  const journal = {
    operationId: "install-001",
    state: "failed",
    services: [
      { service: "web", restored: false },
      { service: "line", restored: true },
    ],
  };
  await reconcileProtectedInstall({
    journal,
    allowedServices: ["web", "line"],
    restore: async (service: string) => { restored.push(service); },
    verify: async () => true,
    persist: async () => {},
  });
  assert.deepEqual(restored, ["web"]);
  assert.equal(journal.state, "restored");
  await reconcileProtectedInstall({
    journal,
    allowedServices: ["web", "line"],
    restore: async (service: string) => { restored.push(service); },
    verify: async () => true,
    persist: async () => {},
  });
  assert.deepEqual(restored, ["web"]);
  console.log("protected install rollback tests passed");
}

void main();
