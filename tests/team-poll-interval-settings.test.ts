import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Fastify from "fastify";
import { getAppSettingDefaults, getAppSettingMetadata } from "../src/config/config-catalog.js";
import {
  env,
  MAX_POLL_INTERVAL_MS,
  MAX_TEAM_POLL_INTERVALS_JSON_LENGTH,
  parseTeamPollIntervalsMs,
  resolveDispatcherKeepAliveIntervalMs,
  resolveTeamPollIntervalMs,
} from "../src/config/env.js";
import { getSpxDispatcher, reconfigureSpxDispatcher } from "../src/utils/http-dispatcher.js";
import {
  acquireLiveSettingsSync,
  onLiveSettingsReloaded,
  reloadSettingsLive,
  SETTINGS_KEYS,
  writeSettings,
} from "../src/services/settings.js";
import { settingsController } from "../src/controllers/settings-controller.js";
import { Poller } from "../src/controllers/poller.js";
import { MetricsCollector } from "../src/services/metrics.js";
import { pauseTeam, resumeTeam } from "../src/services/poller-control.js";
import {
  ApiSection,
  formatPollIntervalLabel,
  INITIAL_SETTINGS_FORM,
  parseTeamPollIntervalDraft,
  serializeTeamPollIntervalDraft,
  SettingsFormProvider,
  validateNumericFields,
  validateTeamPollIntervals,
} from "../src/frontend/lib/settings-shared.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testCatalogAndParsers(): Promise<void> {
  assert.equal(
    SETTINGS_KEYS.includes("TEAM_POLL_INTERVALS_MS"),
    true,
    "TEAM_POLL_INTERVALS_MS must be registered in SETTINGS_KEYS",
  );
  const meta = getAppSettingMetadata("TEAM_POLL_INTERVALS_MS");
  assert.equal(meta.defaultValue, "{}");
  assert.equal(meta.secret, false);
  assert.equal(meta.reload, "live");
  assert.equal(getAppSettingDefaults().TEAM_POLL_INTERVALS_MS, "{}");

  assert.deepEqual(parseTeamPollIntervalsMs(undefined), { ok: true, value: {} });
  assert.deepEqual(parseTeamPollIntervalsMs(""), { ok: true, value: {} });
  assert.deepEqual(parseTeamPollIntervalsMs("  {}  "), { ok: true, value: {} });
  assert.deepEqual(parseTeamPollIntervalsMs('{"1":500,"2":5000,"3":1000}'), {
    ok: true,
    value: { 1: 500, 2: 5000, 3: 1000 },
  });
  assert.equal(MAX_POLL_INTERVAL_MS, 2_147_483_647);
  assert.deepEqual(parseTeamPollIntervalsMs(`{"1":${MAX_POLL_INTERVAL_MS}}`), {
    ok: true,
    value: { 1: MAX_POLL_INTERVAL_MS },
  });

  const invalidPayloads = [
    "{not-json",
    "[1000]",
    '"1000"',
    '{"0":1000}',
    '{"-1":1000}',
    '{"01":1000}',
    '{"abc":1000}',
    '{"__proto__":1000}',
    '{"1":0}',
    '{"1":-500}',
    '{"1":1.5}',
    '{"1":"1000"}',
    '{"1":null}',
    `{"1":${MAX_POLL_INTERVAL_MS + 1}}`,
    '{"1":1788195600000}',
  ];
  for (const bad of invalidPayloads) {
    const parsed = parseTeamPollIntervalsMs(bad);
    assert.equal(parsed.ok, false, `Expected parseTeamPollIntervalsMs(${bad}) to fail`);
  }

  // Max entries bound and VARCHAR(4000) serialized JSON length bound
  const huge: Record<string, number> = {};
  for (let i = 1; i <= 501; i += 1) huge[String(i)] = 1000;
  assert.equal(parseTeamPollIntervalsMs(JSON.stringify(huge)).ok, false);

  const over4000: Record<string, number> = {};
  for (let i = 100; i <= 499; i += 1) over4000[String(i)] = 1234567;
  const over4000Json = JSON.stringify(over4000);
  assert.ok(over4000Json.length > MAX_TEAM_POLL_INTERVALS_JSON_LENGTH);
  assert.equal(
    parseTeamPollIntervalsMs(over4000Json).ok,
    false,
    "serialized JSON > VARCHAR(4000) must be rejected cleanly",
  );

  // Precedence: CLI override > team override > global POLL_INTERVAL_MS
  const mutableEnv = env as unknown as {
    POLL_INTERVAL_MS: number;
    TEAM_POLL_INTERVALS_MS: Record<number, number>;
  };
  const origGlobal = mutableEnv.POLL_INTERVAL_MS;
  const origTeams = mutableEnv.TEAM_POLL_INTERVALS_MS;
  try {
    mutableEnv.POLL_INTERVAL_MS = 30000;
    mutableEnv.TEAM_POLL_INTERVALS_MS = { 1: 750, 2: 4000 };

    assert.equal(resolveTeamPollIntervalMs(1), 750);
    assert.equal(resolveTeamPollIntervalMs(2), 4000);
    assert.equal(resolveTeamPollIntervalMs(3), 30000);
    assert.equal(resolveTeamPollIntervalMs(1, 2000), 2000);

    // Keep-alive sizing for dedicated worker vs combined process
    assert.equal(resolveDispatcherKeepAliveIntervalMs(30000, { 1: 750, 2: 4000 }, [1]), 750);
    assert.equal(resolveDispatcherKeepAliveIntervalMs(30000, { 1: 750, 2: 4000 }, [3]), 30000);
    assert.equal(resolveDispatcherKeepAliveIntervalMs(30000, { 1: 750, 2: 90000 }, [1, 2]), 90000);
    assert.equal(resolveDispatcherKeepAliveIntervalMs(30000, { 1: 750, 2: 90000 }, []), 90000);

    // Tuning sub-30s intervals (all within the 60s keep-alive floor) must preserve the warm Agent pool
    reconfigureSpxDispatcher(1000);
    const warmAgent = getSpxDispatcher();
    reconfigureSpxDispatcher(500);
    assert.equal(getSpxDispatcher(), warmAgent, "sub-30s tuning must not tear down warm Agent pool");
    reconfigureSpxDispatcher(5000);
    assert.equal(getSpxDispatcher(), warmAgent, "5s tuning still shares 60s keep-alive floor");
  } finally {
    mutableEnv.POLL_INTERVAL_MS = origGlobal;
    mutableEnv.TEAM_POLL_INTERVALS_MS = origTeams;
  }
}

async function testSettingsPersistenceAndController(): Promise<void> {
  const keysToRestore = [
    "API_URL",
    "APP_NAME",
    "REFERER",
    "COOKIE",
    "DEVICE_ID",
    "HTTP_ENABLED",
    "SAVE_TO_DB",
    "AUTO_ACCEPT_ENABLED",
    "POLL_INTERVAL_MS",
    "TEAM_POLL_INTERVALS_MS",
  ] as const;
  const previousEnv = new Map<string, string | undefined>();
  for (const key of keysToRestore) previousEnv.set(key, process.env[key]);

  process.env.HTTP_ENABLED = "false";
  process.env.COOKIE = "test-cookie";
  process.env.DEVICE_ID = "test-device";

  const stored: Record<string, string> = {
    API_URL: "https://spx.example.com/api/booking/bidding/list",
    APP_NAME: "SPX Test",
    REFERER: "https://spx.example.com/",
    SAVE_TO_DB: "false",
    AUTO_ACCEPT_ENABLED: "false",
    POLL_INTERVAL_MS: "30000",
    TEAM_POLL_INTERVALS_MS: "{}",
  };
  const deps = {
    getAppSettingsImpl: async () => ({ ...stored }),
    upsertAppSettingsImpl: async (next: Record<string, string>) => {
      Object.assign(stored, next);
    },
  };

  let reloadNotifications = 0;
  const unsubscribe = onLiveSettingsReloaded(() => {
    reloadNotifications += 1;
  });

  try {
    await writeSettings(
      {
        ...stored,
        POLL_INTERVAL_MS: "30000",
        TEAM_POLL_INTERVALS_MS: '{"1":800,"2":5000}',
      },
      deps,
    );
    await reloadSettingsLive(deps);
    assert.deepEqual(env.TEAM_POLL_INTERVALS_MS, { 1: 800, 2: 5000 });
    assert.equal(reloadNotifications, 1, "writeSettings + unchanged reloadSettingsLive must notify listeners once");

    // Second reloadSettingsLive with identical DB snapshot must be a no-op (zero extra notifications)
    await reloadSettingsLive(deps);
    assert.equal(reloadNotifications, 1, "unchanged reloadSettingsLive must not fire duplicate notifications");

    // Concurrent reloadSettingsLive calls must single-flight deduplicate DB reads
    let dbReads = 0;
    const dedupDeps = {
      getAppSettingsImpl: async () => {
        dbReads += 1;
        await wait(30);
        return { ...stored, TEAM_POLL_INTERVALS_MS: '{"1":900,"2":5000}' };
      },
    };
    await Promise.all([reloadSettingsLive(dedupDeps), reloadSettingsLive(dedupDeps)]);
    assert.equal(dbReads, 1, "concurrent reloadSettingsLive calls must share one in-flight read");
    assert.deepEqual(env.TEAM_POLL_INTERVALS_MS, { 1: 900, 2: 5000 });
    assert.equal(reloadNotifications, 2);

    // Invalid value must reject and roll back env cleanly without notifying listeners
    await assert.rejects(
      () => writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":0}' }, deps),
      /TEAM_POLL_INTERVALS_MS/,
    );
    assert.deepEqual(env.TEAM_POLL_INTERVALS_MS, { 1: 900, 2: 5000 });
    assert.equal(reloadNotifications, 2);

    // DB upsert failure in writeSettings must roll back in-memory env & process.env cleanly
    await assert.rejects(
      () =>
        writeSettings(
          { TEAM_POLL_INTERVALS_MS: '{"1":333}' },
          {
            upsertAppSettingsImpl: async () => {
              throw new Error("simulated DB write timeout");
            },
          },
        ),
      /simulated DB write timeout/,
    );
    assert.deepEqual(env.TEAM_POLL_INTERVALS_MS, { 1: 900, 2: 5000 });
    assert.equal(reloadNotifications, 2);

    // Concurrent writeSettings calls must serialize so a failing write A never clobbers committed write B
    const writeAFails = writeSettings(
      { TEAM_POLL_INTERVALS_MS: '{"1":444}' },
      {
        upsertAppSettingsImpl: async () => {
          await wait(35);
          throw new Error("write-A DB error");
        },
      },
    );
    const writeBSucceeds = writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":1234,"2":5000}' }, deps);
    const [resA, resB] = await Promise.allSettled([writeAFails, writeBSucceeds]);
    assert.equal(resA.status, "rejected");
    assert.equal(resB.status, "fulfilled");
    assert.deepEqual(
      env.TEAM_POLL_INTERVALS_MS,
      { 1: 1234, 2: 5000 },
      "rollback of failed write A must never clobber subsequent committed write B",
    );

    // Ref-counted process-wide live settings sync shares 1 timer across multiple teams
    let sharedSyncReads = 0;
    const sharedSyncDeps = {
      getAppSettingsImpl: async () => {
        sharedSyncReads += 1;
        return { ...stored, TEAM_POLL_INTERVALS_MS: '{"1":1500,"2":5000}' };
      },
    };
    const release1 = acquireLiveSettingsSync(50, sharedSyncDeps);
    const release2 = acquireLiveSettingsSync(50, sharedSyncDeps);
    const release3 = acquireLiveSettingsSync(50, sharedSyncDeps);
    try {
      await wait(130);
      assert.ok(
        sharedSyncReads >= 1 && sharedSyncReads <= 3,
        `Expected 1 shared sync timer (~2 reads in 130ms across 3 teams), got ${sharedSyncReads}`,
      );
      assert.deepEqual(env.TEAM_POLL_INTERVALS_MS, { 1: 1500, 2: 5000 });
    } finally {
      await release1();
      await release2();
      await release3();
    }
    const readsAfterRelease = sharedSyncReads;
    await wait(90);
    assert.equal(sharedSyncReads, readsAfterRelease, "releasing all sync handles must stop timer cleanly");

    // Invalid DB row during reloadSettingsLive must roll back and NOT notify listeners
    const notificationsBeforeInvalidReload = reloadNotifications;
    await reloadSettingsLive({
      getAppSettingsImpl: async () => ({ ...stored, TEAM_POLL_INTERVALS_MS: '{"1":0}' }),
    });
    assert.deepEqual(env.TEAM_POLL_INTERVALS_MS, { 1: 1500, 2: 5000 });
    assert.equal(reloadNotifications, notificationsBeforeInvalidReload);

    // Settings controller rejects invalid TEAM_POLL_INTERVALS_MS & POLL_INTERVAL_MS with 400
    // and exposes live reloadBehavior on GET
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req) => {
      (req as { user?: unknown }).user = { id: 1, username: "admin", role: "admin" };
    });
    await app.register(settingsController, { prefix: "/api/settings" });
    await app.ready();
    try {
      const getRes = await app.inject({ method: "GET", url: "/api/settings" });
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.json().data?.reloadBehavior?.TEAM_POLL_INTERVALS_MS, "live");

      const badTeamRes = await app.inject({
        method: "POST",
        url: "/api/settings",
        payload: { TEAM_POLL_INTERVALS_MS: '{"1":-5}' },
      });
      assert.equal(badTeamRes.statusCode, 400);
      assert.equal(badTeamRes.json().error_code, "INVALID_SETTINGS");

      const badGlobalOverflowRes = await app.inject({
        method: "POST",
        url: "/api/settings",
        payload: { POLL_INTERVAL_MS: String(MAX_POLL_INTERVAL_MS + 1) },
      });
      assert.equal(badGlobalOverflowRes.statusCode, 400);
      assert.equal(badGlobalOverflowRes.json().error_code, "INVALID_SETTINGS");

      const over4000Map: Record<string, number> = {};
      for (let i = 100; i <= 499; i += 1) over4000Map[String(i)] = 1234567;
      const badTooLongRes = await app.inject({
        method: "POST",
        url: "/api/settings",
        payload: { TEAM_POLL_INTERVALS_MS: JSON.stringify(over4000Map) },
      });
      assert.equal(badTooLongRes.statusCode, 400);
      assert.equal(badTooLongRes.json().error_code, "INVALID_SETTINGS");
    } finally {
      await app.close();
    }
  } finally {
    unsubscribe();
    for (const [key, val] of previousEnv.entries()) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

async function testPollerLiveIndependentIntervalsAndWakeup(): Promise<void> {
  const keysToRestore = [
    "API_URL",
    "APP_NAME",
    "REFERER",
    "COOKIE",
    "DEVICE_ID",
    "HTTP_ENABLED",
    "FETCH_DETAILS",
    "SAVE_TO_DB",
    "AUTO_ACCEPT_ENABLED",
    "POLL_INTERVAL_MS",
    "TEAM_POLL_INTERVALS_MS",
  ] as const;
  const previousEnv = new Map<string, string | undefined>();
  for (const key of keysToRestore) previousEnv.set(key, process.env[key]);

  process.env.HTTP_ENABLED = "false";
  process.env.COOKIE = "test-cookie";
  process.env.DEVICE_ID = "test-device";

  const stored: Record<string, string> = {
    API_URL: "https://spx.example.com/api/booking/bidding/list",
    APP_NAME: "SPX Test",
    REFERER: "https://spx.example.com/",
    POLL_INTERVAL_MS: "30000",
    TEAM_POLL_INTERVALS_MS: '{"1":70}',
    FETCH_DETAILS: "false",
    SAVE_TO_DB: "false",
    AUTO_ACCEPT_ENABLED: "false",
  };
  const deps = {
    getAppSettingsImpl: async () => ({ ...stored }),
    upsertAppSettingsImpl: async (next: Record<string, string>) => {
      Object.assign(stored, next);
    },
  };

  let team1Ticks = 0;
  let team2Ticks = 0;
  const createStubApiClient = (onFetch: () => void) => ({
    metricsCollector: new MetricsCollector(),
    fetch: async () => {
      onFetch();
      return {
        success: true,
        data: { list: [], total: 0 },
        latencyMs: 1,
        requestCount: 1,
      };
    },
  });

  await writeSettings(stored, deps);
  await reloadSettingsLive(deps);

  const poller1 = new Poller(undefined, {
    teamId: 1,
    teamName: "PTWL",
    apiClient: createStubApiClient(() => {
      team1Ticks += 1;
    }) as never,
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
  });

  const poller2 = new Poller(undefined, {
    teamId: 2,
    teamName: "IFN",
    apiClient: createStubApiClient(() => {
      team2Ticks += 1;
    }) as never,
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
  });

  try {
    resumeTeam(1);
    resumeTeam(2);
    await poller1.start();
    await poller2.start();

    // Let Team 1 (70ms) run multiple ticks while Team 2 (30s global) sleeps after tick #1
    await wait(260);
    assert.ok(team1Ticks >= 3, `Expected Team 1 (>=3 ticks at 70ms), got ${team1Ticks}`);
    assert.equal(team2Ticks, 1, `Expected Team 2 to stay at 1 tick on 30s interval, got ${team2Ticks}`);

    // Now live-update Team 2 from 30s -> 60ms WITHOUT restarting poller2!
    const beforeWakeTicks = team2Ticks;
    await writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":70,"2":60}' }, deps);
    await reloadSettingsLive(deps);

    await wait(240);
    assert.ok(
      team2Ticks >= beforeWakeTicks + 2,
      `Expected Team 2 to wake immediately and run >=2 ticks after live reload (before=${beforeWakeTicks}, after=${team2Ticks})`,
    );

    // Live-lengthening Team 2 back to 30s (clearing override to global) stops rapid ticks immediately
    await writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":70}' }, deps);
    await reloadSettingsLive(deps);
    await wait(20);
    const ticksAfterSlowdown = team2Ticks;
    await wait(160);
    assert.equal(
      team2Ticks,
      ticksAfterSlowdown,
      `Expected Team 2 to slow back down to global 30s without restart (before=${ticksAfterSlowdown}, after=${team2Ticks})`,
    );

    // Paused team must NOT wake up on live settings reload
    pauseTeam(2);
    await wait(90);
    const pausedTicks = team2Ticks;
    await writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":70,"2":40}' }, deps);
    await reloadSettingsLive(deps);
    await wait(120);
    assert.equal(team2Ticks, pausedTicks, "Paused team must stay paused across live settings reload");

    // Poller started with explicit CLI intervalSec must preserve CLI precedence across live reload
    let cliTicks = 0;
    const cliPoller = new Poller(30, {
      teamId: 3,
      teamName: "KRTK",
      apiClient: createStubApiClient(() => {
        cliTicks += 1;
      }) as never,
      manageHttpServer: false,
      manageProcessSignals: false,
      closeSharedResourcesOnStop: false,
      exitOnStop: false,
    });
    try {
      resumeTeam(3);
      await cliPoller.start();
      await wait(40);
      assert.equal(cliTicks, 1);
      await writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":70,"3":40}' }, deps);
      await reloadSettingsLive(deps);
      await wait(140);
      assert.equal(cliTicks, 1, "CLI intervalSec must retain precedence across live TEAM_POLL_INTERVALS_MS reloads");
    } finally {
      await cliPoller.stop(0);
    }

    // Poller in active rate-limit backoff must NOT prematurely wake on live settings reload
    let rlTicks = 0;
    const rlPoller = new Poller(undefined, {
      teamId: 4,
      teamName: "RL-TEAM",
      apiClient: {
        metricsCollector: new MetricsCollector(),
        fetch: async () => {
          rlTicks += 1;
          return {
            success: false,
            status: 200,
            error: "Rate limited (SPX 130008001)",
            retcode: 130008001,
            latencyMs: 1,
            requestCount: rlTicks,
          };
        },
      } as never,
      manageHttpServer: false,
      manageProcessSignals: false,
      closeSharedResourcesOnStop: false,
      exitOnStop: false,
    });
    try {
      resumeTeam(4);
      await rlPoller.start();
      await wait(40);
      assert.equal(rlTicks, 1);
      await writeSettings({ TEAM_POLL_INTERVALS_MS: '{"1":70,"4":30}' }, deps);
      await reloadSettingsLive(deps);
      await wait(140);
      assert.equal(rlTicks, 1, "Rate-limit backoff wait must not be bypassed by live settings reload");
    } finally {
      await rlPoller.stop(0);
    }
  } finally {
    resumeTeam(1);
    resumeTeam(2);
    await poller1.stop(0);
    await poller2.stop(0);
    for (const [key, val] of previousEnv.entries()) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

async function testFrontendSettingsHelpersAndUi(): Promise<void> {
  assert.equal(INITIAL_SETTINGS_FORM.TEAM_POLL_INTERVALS_MS, "{}");
  assert.equal(formatPollIntervalLabel(500), "500 ms");
  assert.equal(formatPollIntervalLabel(1000), "1s");
  assert.equal(formatPollIntervalLabel(1500), "1.5s");
  assert.equal(formatPollIntervalLabel(30000), "30s");

  assert.deepEqual(parseTeamPollIntervalDraft("{}"), {});
  assert.deepEqual(parseTeamPollIntervalDraft('{"1":500,"2":"abc","99999999999999999999":1000}'), {
    1: "500",
    2: "abc",
  });
  assert.equal(serializeTeamPollIntervalDraft({ 2: "5000", 1: "500", 3: "  " }), '{"1":500,"2":5000}');
  assert.equal(serializeTeamPollIntervalDraft({}), "{}");

  // Over-4000 char serialized JSON rejected on frontend too
  const over4000Frontend: Record<string, number> = {};
  for (let i = 100; i <= 499; i += 1) over4000Frontend[String(i)] = 1234567;
  const over4000FrontendResult = validateNumericFields({
    ...INITIAL_SETTINGS_FORM,
    TEAM_POLL_INTERVALS_MS: JSON.stringify(over4000Frontend),
  });
  assert.ok(over4000FrontendResult.errors.TEAM_POLL_INTERVALS_MS);

  // Valid team overrides pass validateNumericFields and canonicalize JSON
  const validResult = validateNumericFields({
    ...INITIAL_SETTINGS_FORM,
    POLL_INTERVAL_MS: "30000",
    TEAM_POLL_INTERVALS_MS: '{"2":5000,"1":500}',
  });
  assert.deepEqual(validResult.errors, {});
  assert.equal(validResult.sanitized.TEAM_POLL_INTERVALS_MS, '{"1":500,"2":5000}');

  // Invalid team override reports per-team error AND blocks form save
  // Leading zeros normalize cleanly; +500, 1e3, overflow > 2^31-1, 0, abc are rejected consistently
  assert.equal(serializeTeamPollIntervalDraft({ 1: "0500" }), '{"1":500}');
  const perTeamErrors = validateTeamPollIntervals(
    `{"1":500,"2":"0","3":"abc","4":"+500","5":"1e3","6":"${MAX_POLL_INTERVAL_MS + 1}"}`,
  );
  assert.equal(perTeamErrors[1], undefined);
  assert.ok(perTeamErrors[2], "team 2 = 0 must produce an inline error");
  assert.ok(perTeamErrors[3], "team 3 = abc must produce an inline error");
  assert.ok(perTeamErrors[4], "team 4 = +500 must be rejected consistently with backend");
  assert.ok(perTeamErrors[5], "team 5 = 1e3 must be rejected consistently with backend");
  assert.ok(perTeamErrors[6], "team 6 > 2^31-1 must be rejected to prevent setTimeout overflow");

  const invalidFormResult = validateNumericFields({
    ...INITIAL_SETTINGS_FORM,
    TEAM_POLL_INTERVALS_MS: '{"2":"0"}',
  });
  assert.ok(
    invalidFormResult.errors.TEAM_POLL_INTERVALS_MS,
    "validateNumericFields must flag invalid TEAM_POLL_INTERVALS_MS",
  );

  // Render ApiSection with teams + an orphaned team override (#99) and verify UI contracts
  const client = new QueryClient();
  client.setQueryData(["settings"], {
    values: {
      ...INITIAL_SETTINGS_FORM,
      POLL_INTERVAL_MS: "30000",
      TEAM_POLL_INTERVALS_MS: '{"1":1000,"99":2500}',
    },
    reloadBehavior: {
      POLL_INTERVAL_MS: "live",
      TEAM_POLL_INTERVALS_MS: "live",
    },
  });
  client.setQueryData(["teams"], [
    { id: 1, name: "PTWL", enabled: true, runtimeStatus: "running" },
    { id: 2, name: "IFN", enabled: true, runtimeStatus: "running" },
  ]);

  const originalReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const markup = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          SettingsFormProvider,
          null,
          React.createElement(ApiSection, {
            formData: {
              ...INITIAL_SETTINGS_FORM,
              POLL_INTERVAL_MS: "30000",
              TEAM_POLL_INTERVALS_MS: '{"1":1000,"99":2500}',
            },
            setField: () => {},
          }),
        ),
      ),
    );
    assert.match(markup, /PTWL/);
    assert.match(markup, /IFN/);
    assert.match(markup, /#99/, "orphaned team override must remain visible so admin can clear it");
    assert.match(markup, /1000/);
    assert.match(markup, /แยกตามทีม/);
    assert.doesNotMatch(
      markup,
      /type="number"[^>]*aria-label="Poll interval ทีม/,
      "per-team poll inputs must use type=text + inputMode=numeric so invalid drafts are not silently cleared by browsers",
    );
    assert.doesNotMatch(
      markup,
      /aria-invalid="false"/,
      "valid per-team inputs must omit aria-invalid=false",
    );
    assert.match(
      markup,
      /aria-label="รีเซ็ต poll interval ทีม PTWL กลับไปใช้ค่ากลาง"/,
      "per-team reset button must expose an accessible aria-label",
    );
  } finally {
    client.clear();
    if (originalReact) Object.defineProperty(globalThis, "React", originalReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

async function run(): Promise<void> {
  await testCatalogAndParsers();
  await testSettingsPersistenceAndController();
  await testPollerLiveIndependentIntervalsAndWakeup();
  await testFrontendSettingsHelpersAndUi();
  console.log("team-poll-interval-settings: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
