import assert from "node:assert/strict";
import type { ProviderAuthRecord } from "../src/models/provider-auth.js";
import { createTeamRuntimeSession } from "../src/services/provider-auth/runtime-session.js";
import { Poller } from "../src/controllers/poller.js";
import type { ApiClient } from "../src/services/api-client.js";
import { clearPausedTeams, pauseTeam } from "../src/services/poller-control.js";

function record(overrides: Partial<ProviderAuthRecord> = {}): ProviderAuthRecord {
  return {
    teamId: 1,
    email: "team@example.test",
    hasPassword: true,
    status: "connected",
    lastLoginAt: null,
    expiresAt: "2030-09-11T08:00:00.000Z",
    errorCode: null,
    retryAt: null,
    storedStatus: "connected",
    password: "saved-password",
    cookie: "cookie-one",
    deviceId: "device-one",
    epoch: 1,
    failures: 0,
    enabled: true,
    ...overrides,
  };
}

async function main(): Promise<void> {
  let now = 0;
  let stored = record();
  let loads = 0;
  let ensures = 0;
  let recoveries = 0;
  const holder = createTeamRuntimeSession(1, { spxCookie: "legacy-cookie", spxDeviceId: "legacy-device" }, {
    clock: () => now,
    load: async () => { loads += 1; return { ...stored }; },
    service: {
      connect: async () => stored,
      reconnect: async () => stored,
      ensure: async () => { ensures += 1; return { ...stored }; },
      recover: async (_teamId, epoch) => {
        recoveries += 1;
        if (epoch === 2) stored = record({ cookie: "cookie-two", deviceId: "device-two", epoch: 3 });
        return true;
      },
    },
  });

  const initial = holder.credentials();
  assert.deepEqual(initial, { spxCookie: "legacy-cookie", spxDeviceId: "legacy-device" });
  assert.equal(await holder.beforePoll(), true);
  assert.deepEqual(holder.credentials(), { spxCookie: "cookie-one", spxDeviceId: "device-one" });
  assert.equal(ensures, 1);
  assert.equal(loads, 1);

  stored = record({ cookie: "cookie-late", deviceId: "device-late", epoch: 2 });
  now = 4_999;
  await holder.beforePoll();
  assert.deepEqual(holder.credentials(), { spxCookie: "cookie-one", spxDeviceId: "device-one" });
  assert.equal(loads, 1, "cache must not reload before five seconds");
  now = 5_000;
  await holder.beforePoll();
  assert.deepEqual(holder.credentials(), { spxCookie: "cookie-late", spxDeviceId: "device-late" });
  assert.equal(loads, 2);

  assert.equal(await holder.recover(), true);
  assert.equal(recoveries, 1);
  assert.deepEqual(holder.credentials(), { spxCookie: "cookie-two", spxDeviceId: "device-two" });

  holder.dispose();
  assert.equal(await holder.beforePoll(), false);
  assert.equal(await holder.recover(), false);

  let manualLogins = 0;
  const manual = createTeamRuntimeSession(2, { spxCookie: "manual-cookie", spxDeviceId: "manual-device" }, {
    load: async () => record({ teamId: 2, hasPassword: false, email: "", password: "", storedStatus: "manual", status: "manual" }),
    service: {
      connect: async () => null,
      reconnect: async () => null,
      ensure: async () => { manualLogins += 1; return null; },
      recover: async () => { manualLogins += 1; return false; },
    },
  });
  assert.equal(await manual.beforePoll(), true);
  assert.equal(await manual.recover(), false);
  assert.equal(manualLogins, 0, "manual credentials must never trigger provider login");

  const missingRecord = createTeamRuntimeSession(3, { spxCookie: "retained-cookie", spxDeviceId: "retained-device" }, {
    load: async () => null,
    service: {
      connect: async () => null,
      reconnect: async () => null,
      ensure: async () => null,
      recover: async () => false,
    },
  });
  assert.equal(await missingRecord.beforePoll(), false, "a missing provider-auth record must block a retained automatic pair");
  assert.deepEqual(missingRecord.credentials(), { spxCookie: "retained-cookie", spxDeviceId: "retained-device" });

  const expired = record({
    status: "retry_wait",
    storedStatus: "retry_wait",
    expiresAt: "1970-01-01T00:00:00.000Z",
    cookie: "expired-cookie",
    deviceId: "expired-device",
  });
  const failedRenewal = createTeamRuntimeSession(4, { spxCookie: "retained-cookie", spxDeviceId: "retained-device" }, {
    load: async () => ({ ...expired }),
    service: {
      connect: async () => expired,
      reconnect: async () => expired,
      ensure: async () => ({ ...expired }),
      recover: async () => false,
    },
  });
  assert.equal(await failedRenewal.beforePoll(), false, "a known-expired automatic session stays blocked after a retained failed renewal");

  const ensureNull = createTeamRuntimeSession(5, { spxCookie: "retained-cookie", spxDeviceId: "retained-device" }, {
    load: async () => record({ teamId: 5 }),
    service: {
      connect: async () => null,
      reconnect: async () => null,
      ensure: async () => null,
      recover: async () => false,
    },
  });
  assert.equal(await ensureNull.beforePoll(), false, "an unavailable ensure result must block the cached automatic pair");

  let resolveLoad: ((value: ProviderAuthRecord | null) => void) | undefined;
  let lateEnsureCalls = 0;
  const disposedDuringLoad = createTeamRuntimeSession(6, { spxCookie: "initial-cookie", spxDeviceId: "initial-device" }, {
    load: async () => new Promise<ProviderAuthRecord | null>((resolve) => { resolveLoad = resolve; }),
    service: {
      connect: async () => null,
      reconnect: async () => null,
      ensure: async () => { lateEnsureCalls += 1; return record({ teamId: 6 }); },
      recover: async () => false,
    },
  });
  const lateBeforePoll = disposedDuringLoad.beforePoll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  disposedDuringLoad.dispose();
  resolveLoad?.(record({ teamId: 6, cookie: "late-cookie", deviceId: "late-device" }));
  assert.equal(await lateBeforePoll, false, "disposing during a load must ignore its late result");
  assert.equal(lateEnsureCalls, 0);
  assert.deepEqual(disposedDuringLoad.credentials(), { spxCookie: "initial-cookie", spxDeviceId: "initial-device" });

  let fetches = 0;
  let releaseBeforePoll: (() => void) | undefined;
  const pausedPoller = new Poller(undefined, {
    teamId: 91,
    teamName: "Paused while authenticating",
    apiClient: { fetch: async () => { fetches += 1; throw new Error("list fetch must not run"); } } as unknown as ApiClient,
    lineGroupId: "",
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
    beforePoll: async () => new Promise<boolean>((resolve) => { releaseBeforePoll = () => resolve(true); }),
  });
  const pausedTick = (pausedPoller as unknown as { tick(): Promise<void> }).tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  pauseTeam(91);
  releaseBeforePoll?.();
  await pausedTick;
  assert.equal(fetches, 0, "a pause while awaiting auth must suppress the list request");
  clearPausedTeams();

  let stopFetches = 0;
  let releaseStoppedHook: (() => void) | undefined;
  const stoppedPoller = new Poller(undefined, {
    teamId: 93,
    teamName: "Stopped while authenticating",
    apiClient: { fetch: async () => { stopFetches += 1; throw new Error("stopped list fetch must not run"); } } as unknown as ApiClient,
    lineGroupId: "",
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
    beforePoll: async () => new Promise<boolean>((resolve) => { releaseStoppedHook = () => resolve(true); }),
  });
  const stoppedTick = (stoppedPoller as unknown as { tick(): Promise<void>; stopped: boolean }).tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  (stoppedPoller as unknown as { stopped: boolean }).stopped = true;
  releaseStoppedHook?.();
  await stoppedTick;
  assert.equal(stopFetches, 0, "a stop while awaiting auth must suppress the list request");

  let recoveryCalls = 0;
  const rejectedPoller = new Poller(undefined, {
    teamId: 92,
    teamName: "Rejected session",
    apiClient: {
      fetch: async () => {
        fetches += 1;
        return { success: false, latencyMs: 1, httpStatus: 401, error: "session expired", timestamp: new Date(), requestNumber: 1 };
      },
    } as unknown as ApiClient,
    lineGroupId: "",
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
    onSessionRejected: async () => { recoveryCalls += 1; return true; },
  });
  await (rejectedPoller as unknown as { tick(): Promise<void> }).tick();
  assert.equal(recoveryCalls, 1, "a candidate rejected list session must call reactive recovery once");
  assert.equal(fetches, 1, "recovery must not replay the rejected list request or any accept mutation");

  const failedRecoveryPoller = new Poller(undefined, {
    teamId: 94,
    teamName: "Failed recovery",
    apiClient: {
      fetch: async () => ({ success: false, latencyMs: 1, httpStatus: 401, error: "session expired", timestamp: new Date(), requestNumber: 1 }),
    } as unknown as ApiClient,
    lineGroupId: "",
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
    onSessionRejected: async () => { throw new Error("provider recovery unavailable"); },
  });
  await (failedRecoveryPoller as unknown as { tick(): Promise<void> }).tick();

  let pausedRecoveryCalls = 0;
  const pausedRejectedPoller = new Poller(undefined, {
    teamId: 95,
    teamName: "Paused after rejected list",
    apiClient: {
      fetch: async () => {
        pauseTeam(95);
        return { success: false, latencyMs: 1, httpStatus: 401, error: "session expired", timestamp: new Date(), requestNumber: 1 };
      },
    } as unknown as ApiClient,
    lineGroupId: "",
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
    onSessionRejected: async () => { pausedRecoveryCalls += 1; return true; },
  });
  await (pausedRejectedPoller as unknown as { tick(): Promise<void> }).tick();
  assert.equal(pausedRecoveryCalls, 0, "a pause after the failed list must suppress automatic recovery");
  clearPausedTeams();

  console.log("provider-auth-runtime: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
