import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  httpSurfaceForRole,
  parseRuntimeRole,
  requireNodeIdForDistributedRole,
  roleRunsHttp,
  roleRunsLineService,
  roleRunsNotifier,
  roleRunsWorkers,
} from "../src/services/runtime-role.js";
import { startNotificationDispatchLoop } from "../src/services/notification-dispatcher.js";

assert.equal(parseRuntimeRole("notification-service"), "notification-service");
assert.equal(parseRuntimeRole("line-service"), "line-service");
assert.equal(parseRuntimeRole("ocr-service"), "ocr-service");
assert.equal(roleRunsHttp("notifier"), true);
assert.equal(roleRunsNotifier("notifier"), true);
assert.equal(roleRunsWorkers("notifier"), false);
assert.equal(roleRunsWorkers("worker"), true);
assert.equal(roleRunsHttp("worker"), false);
assert.equal(roleRunsNotifier("combined"), true);
assert.equal(roleRunsWorkers("combined"), true);
assert.equal(httpSurfaceForRole("api"), "web-api");
assert.equal(httpSurfaceForRole("notifier"), "web-api");
assert.equal(httpSurfaceForRole("combined"), "web-api");
assert.equal(httpSurfaceForRole("worker"), null);
assert.equal(httpSurfaceForRole("line-service"), "line-service");
assert.equal(httpSurfaceForRole("notification-service"), "notification-service");
assert.equal(httpSurfaceForRole("ocr-service"), "ocr-service");
assert.equal(roleRunsNotifier("notification-service"), true);
assert.equal(roleRunsNotifier("line-service"), false);
assert.equal(roleRunsNotifier("ocr-service"), false);
assert.equal(roleRunsHttp("line-service"), true);
assert.equal(roleRunsWorkers("line-service"), false);
assert.equal(roleRunsLineService("line-service"), true);
assert.equal(roleRunsLineService("combined"), true);
assert.equal(roleRunsLineService("notifier"), false);
assert.throws(() => requireNodeIdForDistributedRole("line-service", ""), /SPX_NODE_ID/);
assert.throws(() => requireNodeIdForDistributedRole("notification-service", ""), /SPX_NODE_ID/);
assert.throws(() => requireNodeIdForDistributedRole("ocr-service", ""), /SPX_NODE_ID/);

assert.throws(
  () =>
    startNotificationDispatchLoop({
      nodeId: "notifier-01",
      batchSize: 0,
      lockMs: 30_000,
      intervalMs: 0,
      sendLineMessage: async () => ({ ok: true }),
    }),
  /intervalMs must be greater than 0/,
);

const loop = startNotificationDispatchLoop({
  nodeId: "notifier-01",
  batchSize: 0,
  lockMs: 30_000,
  intervalMs: 1_000,
  sendLineMessage: async () => ({ ok: true }),
});
assert.equal(typeof loop.stop, "function");
loop.stop();
loop.stop();

const validation = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--eval",
    [
      "import { validateRuntimeConfig } from './src/config/env.ts';",
      "try { validateRuntimeConfig(); process.exit(0); }",
      "catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }",
    ].join(" "),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DB_MODE: "memory",
      SPX_ROLE: "notification-service",
      SPX_NODE_ID: "notification-service-01",
      NOTIFIER_SHARED_SECRET: "super-secret-value",
      LINE_SERVICE_URL: "",
      API_URL: "https://spx.example/booking/bidding/list",
      APP_NAME: "SPX",
      REFERER: "https://spx.example/",
      HTTP_ENABLED: "false",
    },
    encoding: "utf8",
  },
);
assert.notEqual(validation.status, 0);
assert.match(`${validation.stdout}\n${validation.stderr}`, /LINE_SERVICE_URL/);
