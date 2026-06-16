import assert from "node:assert/strict";
import { buildHeadersForRequest } from "../src/services/api-client.js";

const headers = buildHeadersForRequest({ spxCookie: "team-cookie", spxDeviceId: "team-device" });
assert.equal(headers.cookie, "team-cookie");
assert.equal(headers["device-id"], "team-device");

console.log("api-client-team-headers: all assertions passed");
