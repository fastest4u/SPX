import assert from "node:assert/strict";
import {
  roleRunsHttp,
  roleRunsNotifier,
  roleRunsWorkers,
} from "../src/services/runtime-role.js";
import { startNotificationDispatchLoop } from "../src/services/notification-dispatcher.js";

assert.equal(roleRunsHttp("notifier"), true);
assert.equal(roleRunsNotifier("notifier"), true);
assert.equal(roleRunsWorkers("notifier"), false);
assert.equal(roleRunsWorkers("worker"), true);
assert.equal(roleRunsHttp("worker"), false);
assert.equal(roleRunsNotifier("combined"), true);
assert.equal(roleRunsWorkers("combined"), true);

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
