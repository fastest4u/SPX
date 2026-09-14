import assert from "node:assert/strict";

import { activateProtectedBaselineServices } from "../scripts/protected-install-watchdog.mjs";

async function main(): Promise<void> {
  const services = ["web", "line"];
  const calls: string[] = [];
  await activateProtectedBaselineServices({
    signedServices: services,
    allowedServices: services,
    adapter: {
      async capture(service: string) { calls.push(`capture:${service}`); return { service }; },
      async activate(service: string) { calls.push(`activate:${service}`); },
      async verify(service: string) { calls.push(`verify:${service}`); return true; },
      async restore(service: string) { calls.push(`restore:${service}`); },
    },
  });
  assert.deepEqual(calls, [
    "capture:web", "activate:web", "verify:web",
    "capture:line", "activate:line", "verify:line",
  ]);

  await assert.rejects(
    () => activateProtectedBaselineServices({
      signedServices: ["web", "unknown"],
      allowedServices: services,
      adapter: {},
    }),
    /service allowlist/i,
  );
  console.log("protected install service activation tests passed");
}

void main();
