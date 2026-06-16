import assert from "node:assert/strict";
import { patchTouchesRuntime, toTeamPatch } from "../src/controllers/teams-controller.js";

assert.deepEqual(toTeamPatch({ name: " A ", enabled: true }), { name: "A", enabled: true });
assert.deepEqual(toTeamPatch({ spxCookie: "********abcd" }), { spxCookie: "********abcd" });
assert.throws(() => toTeamPatch({ name: "" }), /name/i);
assert.equal(patchTouchesRuntime({ name: "Only rename" }), false);
assert.equal(patchTouchesRuntime({ enabled: false }), false);
assert.equal(patchTouchesRuntime({ enabled: true }), true);
assert.equal(patchTouchesRuntime({ spxCookie: "fresh-cookie" }), true);
assert.equal(patchTouchesRuntime({ lineGroupId: "group-id" }), true);

console.log("teams-controller-auth: schema helpers verified");
