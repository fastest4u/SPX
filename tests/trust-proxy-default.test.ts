import assert from "node:assert/strict";
import { parseTrustProxy } from "../src/config/env.js";

assert.equal(parseTrustProxy(undefined), false);
assert.equal(parseTrustProxy(""), false);
assert.equal(parseTrustProxy("false"), false);
assert.equal(parseTrustProxy("true"), true);
assert.equal(parseTrustProxy("1"), 1);
assert.deepEqual(parseTrustProxy("127.0.0.1, 10.0.0.0/8"), ["127.0.0.1", "10.0.0.0/8"]);

console.log("trust-proxy-default: all assertions passed");
