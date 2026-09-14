import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  STAGING_PHASE3_OBSERVER_PASSWORD_PATH,
  STAGING_PHASE3_PRODUCTION_OBSERVER_POLICY_PATH,
  STAGING_PHASE3_PRODUCTION_OBSERVER_TOKEN_PATH,
  validateStagingProductionObserverPolicyBytes,
  validateStagingProductionObserverTokenBytes,
} from "../scripts/lib/staging-production-observer-policy.mjs";

const canonicalPolicy = Buffer.from(
  '{"endpoint":"https://observer.example/internal/ready","schemaVersion":1}',
  "utf8",
);
const policySha256 = createHash("sha256").update(canonicalPolicy).digest("hex");

assert.equal(
  STAGING_PHASE3_PRODUCTION_OBSERVER_POLICY_PATH,
  "/etc/spx-staging/phase3-production-observer-policy.json",
);
assert.equal(
  STAGING_PHASE3_PRODUCTION_OBSERVER_TOKEN_PATH,
  "/run/spx-staging-actions/phase3-production-observer-token",
);
assert.equal(
  STAGING_PHASE3_OBSERVER_PASSWORD_PATH,
  "/run/spx-staging-actions/database/principal-phase3-observer.password",
);
assert.equal(validateStagingProductionObserverPolicyBytes(canonicalPolicy, policySha256), true);

for (const invalidPolicy of [
  Buffer.alloc(0),
  Buffer.alloc(8_193, 0x61),
  Buffer.from([0xc3, 0x28]),
  Buffer.from(`${canonicalPolicy.toString("utf8")}\n`, "utf8"),
  Buffer.from(
    '{"schemaVersion":1,"endpoint":"https://observer.example/internal/ready"}',
    "utf8",
  ),
  Buffer.from(
    '{"endpoint":"https://observer.example/internal/ready","schemaVersion":1,"extra":true}',
    "utf8",
  ),
  Buffer.from(
    '{"endpoint":"https://observer.example/internal/ready","schemaVersion":2}',
    "utf8",
  ),
  Buffer.from('{"endpoint":"http://observer.example/internal/ready","schemaVersion":1}', "utf8"),
  Buffer.from(
    '{"endpoint":"https://user:password@observer.example/internal/ready","schemaVersion":1}',
    "utf8",
  ),
  Buffer.from(
    '{"endpoint":"https://observer.example/internal/ready?verbose=1","schemaVersion":1}',
    "utf8",
  ),
  Buffer.from(
    '{"endpoint":"https://observer.example/internal/ready#status","schemaVersion":1}',
    "utf8",
  ),
]) {
  assert.throws(
    () => validateStagingProductionObserverPolicyBytes(invalidPolicy, policySha256),
    /production observer policy/i,
  );
}

assert.throws(
  () => validateStagingProductionObserverPolicyBytes(canonicalPolicy, "0".repeat(64)),
  /production observer policy/i,
);
assert.throws(
  () => validateStagingProductionObserverPolicyBytes(canonicalPolicy, policySha256.toUpperCase()),
  /production observer policy/i,
);

const classifiedPolicy = Buffer.from(
  '{"endpoint":"https://classified.example/private/ready","schemaVersion":1}',
  "utf8",
);
try {
  validateStagingProductionObserverPolicyBytes(classifiedPolicy, policySha256);
  assert.fail("classified policy mismatch must fail");
} catch (error) {
  assert.doesNotMatch(String(error), /classified|private\/ready|https:/i);
}

const validToken = Buffer.from("A1bcdefghijklmnopqrstuvwxyz-_~+/AB", "utf8");
assert.equal(validateStagingProductionObserverTokenBytes(validToken), true);
assert.equal(validateStagingProductionObserverTokenBytes(Buffer.alloc(4_096, 0x41)), true);

for (const invalidToken of [
  Buffer.alloc(31, 0x41),
  Buffer.alloc(4_097, 0x41),
  Buffer.from([0xc3, 0x28, ...Buffer.alloc(30, 0x41)]),
  Buffer.from(`${"A".repeat(32)}\n`, "utf8"),
  Buffer.from(`${"A".repeat(31)} `, "utf8"),
  Buffer.from(`${"A".repeat(31)}!`, "utf8"),
  Buffer.from(`${"A".repeat(16)}=${"A".repeat(16)}`, "utf8"),
  Buffer.from(`${"A".repeat(32)}===`, "utf8"),
]) {
  assert.throws(
    () => validateStagingProductionObserverTokenBytes(invalidToken),
    /production observer token/i,
  );
}

const classifiedToken = Buffer.from("CLASSIFIED-token-value-that-is-long-enough", "utf8");
try {
  validateStagingProductionObserverTokenBytes(
    Buffer.from(`${classifiedToken.toString("utf8")}!`, "utf8"),
  );
  assert.fail("classified token bytes must fail");
} catch (error) {
  assert.doesNotMatch(String(error), /CLASSIFIED|token-value-that-is-long-enough/);
}
