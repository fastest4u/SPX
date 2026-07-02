import assert from "node:assert/strict";
import { patchTouchesRuntime, resolveTeamRuntimeStatus, toTeamPatch } from "../src/controllers/teams-controller.js";

assert.deepEqual(toTeamPatch({ name: " A ", enabled: true }), { name: "A", enabled: true });
assert.deepEqual(toTeamPatch({ spxCookie: "********abcd" }), { spxCookie: "********abcd" });
assert.throws(() => toTeamPatch({ name: "" }), /name/i);
assert.equal(patchTouchesRuntime({ name: "Only rename" }), false);
assert.equal(patchTouchesRuntime({ enabled: false }), false);
assert.equal(patchTouchesRuntime({ enabled: true }), true);
assert.equal(patchTouchesRuntime({ spxCookie: "fresh-cookie" }), true);
assert.equal(patchTouchesRuntime({ lineGroupId: "group-id" }), true);

const runtimeTeam = {
  id: 2,
  name: "PTWL",
  enabled: true,
  hasSpxCookie: true,
  hasSpxDeviceId: true,
};
const now = new Date("2030-06-29T07:00:00.000Z");

assert.equal(
  resolveTeamRuntimeStatus({
    team: runtimeTeam,
    localStatus: null,
    desiredState: undefined,
    lease: {
      teamId: runtimeTeam.id,
      status: "running",
      leaseExpiresAt: new Date("2030-06-29T07:00:30.000Z"),
    },
    now,
  }),
  "running",
  "teams list should show a worker-held active lease as running when the API process has no local runtime",
);

assert.equal(
  resolveTeamRuntimeStatus({
    team: runtimeTeam,
    localStatus: null,
    desiredState: "paused",
    lease: {
      teamId: runtimeTeam.id,
      status: "running",
      leaseExpiresAt: new Date("2030-06-29T07:00:30.000Z"),
    },
    now,
  }),
  "paused",
  "central pause requests should be visible while the worker keeps the lease",
);

assert.equal(
  resolveTeamRuntimeStatus({
    team: runtimeTeam,
    localStatus: null,
    desiredState: undefined,
    lease: {
      teamId: runtimeTeam.id,
      status: "running",
      leaseExpiresAt: new Date("2030-06-29T06:59:59.000Z"),
    },
    now,
  }),
  "stopped",
  "expired worker leases should not keep a team marked as running",
);

assert.equal(
  resolveTeamRuntimeStatus({
    team: runtimeTeam,
    localStatus: null,
    desiredState: "paused",
    lease: undefined,
    now,
  }),
  "stopped",
  "stale paused desired state should not look paused without an active worker lease",
);

console.log("teams-controller-auth: schema helpers verified");
