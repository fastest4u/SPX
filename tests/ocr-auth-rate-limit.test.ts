import assert from "node:assert/strict";
import {
  OCR_AUTH_RATE_LIMIT_POLICIES,
  createOcrAuthRateLimiter,
  type OcrAuthAction,
} from "../src/services/ocr-auth-rate-limit.js";

assert.equal(Object.isFrozen(OCR_AUTH_RATE_LIMIT_POLICIES), true);
for (const policy of Object.values(OCR_AUTH_RATE_LIMIT_POLICIES)) {
  assert.equal(Object.isFrozen(policy), true);
}
assert.deepEqual(OCR_AUTH_RATE_LIMIT_POLICIES, {
  status: { actorLimit: 60, ipLimit: 120, windowMs: 60_000 },
  start: { actorLimit: 3, ipLimit: 10, windowMs: 15 * 60_000 },
  complete: { actorLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 },
  logout: { actorLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 },
});

let now = 1_000_000;
const limiter = createOcrAuthRateLimiter({ now: () => now, maxBuckets: 1_000 });

for (let count = 0; count < 60; count += 1) {
  assert.equal(limiter.consume({ action: "status", actorUserId: 1, clientIp: "192.0.2.1" }).allowed, true);
}
const actorDenied = limiter.consume({ action: "status", actorUserId: 1, clientIp: "192.0.2.1" });
assert.deepEqual(actorDenied, {
  allowed: false,
  limitingScope: "actor",
  resetAt: now + 60_000,
  retryAfterMs: 60_000,
  shouldAudit: true,
});
assert.equal(
  limiter.consume({ action: "status", actorUserId: 1, clientIp: "192.0.2.1" }).shouldAudit,
  false,
  "repeat denials in one actor/action window must not flood audit logs",
);

// The denied actor request above must not consume the shared IP bucket again.
for (let count = 0; count < 60; count += 1) {
  assert.equal(limiter.consume({ action: "status", actorUserId: 2, clientIp: "192.0.2.1" }).allowed, true);
}
const ipDenied = limiter.consume({ action: "status", actorUserId: 3, clientIp: "192.0.2.1" });
assert.equal(ipDenied.allowed, false);
assert.equal(ipDenied.limitingScope, "ip");
assert.equal(ipDenied.shouldAudit, true);

for (const [action, limit] of [
  ["start", 3],
  ["complete", 5],
  ["logout", 5],
] as const satisfies ReadonlyArray<readonly [OcrAuthAction, number]>) {
  const actionLimiter = createOcrAuthRateLimiter({ now: () => now });
  for (let count = 0; count < limit; count += 1) {
    assert.equal(
      actionLimiter.consume({ action, actorUserId: 10, clientIp: `198.51.100.${limit}` }).allowed,
      true,
    );
  }
  const denied = actionLimiter.consume({
    action,
    actorUserId: 10,
    clientIp: `198.51.100.${limit}`,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.limitingScope, "actor");
}

const sharedIpLimiter = createOcrAuthRateLimiter({ now: () => now });
for (let actorUserId = 1; actorUserId <= 10; actorUserId += 1) {
  assert.equal(
    sharedIpLimiter.consume({ action: "start", actorUserId, clientIp: "203.0.113.9" }).allowed,
    true,
  );
}
const sharedIpDenied = sharedIpLimiter.consume({
  action: "start",
  actorUserId: 11,
  clientIp: "203.0.113.9",
});
assert.equal(sharedIpDenied.allowed, false);
assert.equal(sharedIpDenied.limitingScope, "ip");

now += 15 * 60_000 + 1;
const afterReset = sharedIpLimiter.consume({
  action: "start",
  actorUserId: 1,
  clientIp: "203.0.113.9",
});
assert.equal(afterReset.allowed, true);

const bounded = createOcrAuthRateLimiter({ now: () => now, maxBuckets: 8 });
for (let actorUserId = 1; actorUserId <= 20; actorUserId += 1) {
  bounded.consume({ action: "status", actorUserId, clientIp: `10.0.0.${actorUserId}` });
}
assert.ok(bounded.bucketCount() <= 8, "rate-limit storage must remain bounded");

assert.throws(
  () => limiter.consume({ action: "status", actorUserId: 0, clientIp: "192.0.2.1" }),
  /actorUserId/,
);
assert.throws(
  () => limiter.consume({ action: "status", actorUserId: 1, clientIp: "" }),
  /clientIp/,
);
