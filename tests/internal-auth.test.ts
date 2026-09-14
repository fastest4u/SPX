import assert from "node:assert/strict";
import {
  createInternalSignature,
  InternalRequestReplayGuard,
  prepareInternalRequestReplay,
  verifyInternalNodeSignature,
  verifyInternalSignature,
} from "../src/services/internal-auth.js";

const body = JSON.stringify({ ok: true });
const timestamp = new Date().toISOString();
const nodeId = "ifn-worker-01";
const path = "/internal/notification-events";
const secret = "super-secret-value";
const eventKey = "auto_accept_owned:team:2:booking:2791810:req:40288114";

const signature = createInternalSignature({ body, timestamp, nodeId, path, secret });
assert.equal(verifyInternalSignature({ body, timestamp, nodeId, path, secret, signature, now: new Date(timestamp) }).ok, true);

const eventKeySignature = createInternalSignature({ body, timestamp, nodeId, path, secret, eventKey });
assert.equal(verifyInternalSignature({ body, timestamp, nodeId, path, secret, eventKey, signature: eventKeySignature, now: new Date(timestamp) }).ok, true);
assert.equal(
  verifyInternalSignature({
    body,
    timestamp,
    nodeId,
    path,
    secret,
    eventKey: `${eventKey}:tampered`,
    signature: eventKeySignature,
    now: new Date(timestamp),
  }).ok,
  false,
);
assert.deepEqual(
  verifyInternalSignature({ body, timestamp, nodeId, path, secret, eventKey: " ", signature: eventKeySignature, now: new Date(timestamp) }),
  { ok: false, reason: "invalid_event_key" },
);

assert.equal(verifyInternalSignature({ body: body.replace("true", "false"), timestamp, nodeId, path, secret, signature, now: new Date(timestamp) }).ok, false);
assert.equal(verifyInternalSignature({ body, timestamp, nodeId, path, secret: "wrong", signature, now: new Date(timestamp) }).ok, false);
assert.deepEqual(
  verifyInternalSignature({ body, timestamp, nodeId, path, secret, signature: `${signature}zz`, now: new Date(timestamp) }),
  { ok: false, reason: "invalid_signature" },
);
assert.deepEqual(
  verifyInternalSignature({ body, timestamp, nodeId, path, secret, signature: "not-hex", now: new Date(timestamp) }),
  { ok: false, reason: "invalid_signature" },
);
assert.doesNotThrow(() => verifyInternalSignature({
  body,
  timestamp,
  nodeId,
  path,
  secret,
  signature: undefined as unknown as string,
  now: new Date(timestamp),
}));
assert.deepEqual(
  verifyInternalSignature({
    body,
    timestamp,
    nodeId,
    path,
    secret,
    signature: undefined as unknown as string,
    now: new Date(timestamp),
  }),
  { ok: false, reason: "invalid_signature" },
);
assert.deepEqual(verifyInternalSignature({ body: " ", timestamp, nodeId, path, secret, signature, now: new Date(timestamp) }), { ok: false, reason: "invalid_body" });
assert.deepEqual(verifyInternalSignature({ body, timestamp, nodeId: " ", path, secret, signature, now: new Date(timestamp) }), { ok: false, reason: "invalid_node_id" });
assert.deepEqual(verifyInternalSignature({ body, timestamp, nodeId, path: " ", secret, signature, now: new Date(timestamp) }), { ok: false, reason: "invalid_path" });
assert.deepEqual(verifyInternalSignature({ body, timestamp, nodeId, path, secret: " ", signature, now: new Date(timestamp) }), { ok: false, reason: "invalid_secret" });

assert.throws(() => createInternalSignature({ body: " ", timestamp, nodeId, path, secret }), /body/);
assert.throws(() => createInternalSignature({ body, timestamp, nodeId: " ", path, secret }), /nodeId/);
assert.throws(() => createInternalSignature({ body, timestamp, nodeId, path: " ", secret }), /path/);
assert.throws(() => createInternalSignature({ body, timestamp, nodeId, path, secret: " " }), /secret/);
assert.throws(() => createInternalSignature({ body, timestamp, nodeId, path, secret, eventKey: " " }), /eventKey/);

const stale = new Date(Date.parse(timestamp) + 10 * 60_000);
assert.equal(verifyInternalSignature({ body, timestamp, nodeId, path, secret, signature, now: stale, maxSkewMs: 60_000 }).ok, false);

function testLegacySignatureBytesStayStable(): void {
  const fixedTimestamp = "2026-09-12T00:00:00.000Z";
  const fixedBody = "{ok:true}";
  assert.equal(
    createInternalSignature({ body: fixedBody, timestamp: fixedTimestamp, nodeId, path, secret }),
    "4f64ccc3193a1427c115db5f19d824188db6120fe5f3c1807f2e2c383beb8a0a",
  );
  assert.equal(
    createInternalSignature({ body: fixedBody, timestamp: fixedTimestamp, nodeId, path, secret, eventKey }),
    "3007fd2d64f0f030ad442a40cf89a7b2dc0a6515cae2cd67b29f88668a4cf933",
  );
}

function testRequestIdIsBoundIntoSignature(): void {
  const fixedTimestamp = "2026-09-12T00:00:00.000Z";
  const fixedBody = "{ok:true}";
  const requestId = "request-123";
  const requestSignature = createInternalSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    secret,
    requestId,
    nodeEnvironment: "production",
  });
  assert.notEqual(requestSignature, signature);
  assert.deepEqual(verifyInternalSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    secret,
    requestId,
    nodeEnvironment: "production",
    signature: requestSignature,
    now: new Date(fixedTimestamp),
  }), { ok: true });
  assert.deepEqual(verifyInternalSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    secret,
    requestId: "request-456",
    nodeEnvironment: "production",
    signature: requestSignature,
    now: new Date(fixedTimestamp),
  }), { ok: false, reason: "signature_mismatch" });
  assert.deepEqual(verifyInternalSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    secret,
    requestId,
    nodeEnvironment: "test",
    signature: requestSignature,
    now: new Date(fixedTimestamp),
  }), { ok: false, reason: "signature_mismatch" });
  assert.deepEqual(verifyInternalSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    secret,
    requestId: " ",
    nodeEnvironment: "production",
    signature: requestSignature,
    now: new Date(fixedTimestamp),
  }), { ok: false, reason: "invalid_request_id" });
}

function testNodeKeyRotationIsNodeAndGenerationScoped(): void {
  const fixedTimestamp = "2026-09-12T00:00:00.000Z";
  const fixedBody = "{ok:true}";
  const requestId = "rotation-request-1";
  const activeSecret = "active-secret-value";
  const previousSecret = "previous-secret-value";
  const nodeSecrets = new Map([
    [nodeId, {
      active: activeSecret,
      previous: previousSecret,
      previousExpiresAt: "2026-09-12T00:01:00.000Z",
    }],
    ["other-node", { active: activeSecret }],
  ]);
  const generations: string[] = [];
  const previousSignature = createInternalSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    secret: previousSecret,
    requestId,
  });
  assert.deepEqual(verifyInternalNodeSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    signature: previousSignature,
    requestId,
    nodeSecrets,
    now: new Date("2026-09-12T00:00:30.000Z"),
    onKeyGeneration: (generation) => generations.push(generation),
  }), { ok: true });
  assert.deepEqual(generations, ["previous"]);
  assert.deepEqual(verifyInternalNodeSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId: "other-node",
    path,
    signature: previousSignature,
    requestId,
    nodeSecrets,
    now: new Date("2026-09-12T00:00:30.000Z"),
  }), { ok: false, reason: "signature_mismatch" });
  assert.deepEqual(verifyInternalNodeSignature({
    body: fixedBody,
    timestamp: fixedTimestamp,
    nodeId,
    path,
    signature: previousSignature,
    requestId,
    nodeSecrets,
    now: new Date("2026-09-12T00:01:00.000Z"),
  }), { ok: false, reason: "signature_mismatch" });
}

async function testReplayGuardBoundsCollisionsAndExpiry(): Promise<void> {
  const startedAt = new Date("2026-09-12T00:00:00.000Z");
  const guard = new InternalRequestReplayGuard({
    maxSkewMs: 100,
    maxEntries: 2,
    maxEntriesPerPartition: 1,
  });
  const base = {
    nodeId,
    signedTimestamp: startedAt.toISOString(),
    partition: "notification-events",
    now: startedAt,
  };
  assert.deepEqual(await guard.consume({ ...base, requestId: "request-a" }), { ok: true });
  assert.deepEqual(await guard.consume({ ...base, requestId: "request-a" }), { ok: false, reason: "replay" });
  assert.deepEqual(await guard.consume({ ...base, requestId: "request-b" }), { ok: false, reason: "capacity" });
  assert.deepEqual(await guard.consume({ ...base, partition: "realtime-events", requestId: "request-a" }), { ok: true });

  const afterExpiry = new Date(startedAt.getTime() + 201);
  assert.deepEqual(await guard.consume({
    ...base,
    requestId: "request-b",
    signedTimestamp: afterExpiry.toISOString(),
    now: afterExpiry,
  }), { ok: true });

  const prepared = prepareInternalRequestReplay({ ...base, requestId: "prepared-request" }, 100);
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.value.expiresAt.toISOString(), "2026-09-12T00:00:00.200Z");
    assert.match(prepared.value.fingerprint, /^[0-9a-f]{64}$/);
  }

  const unavailable = new InternalRequestReplayGuard({
    store: { consume: async () => { throw new Error("unavailable"); } },
  });
  assert.deepEqual(await unavailable.consume({ ...base, requestId: "request-c" }), { ok: false, reason: "capacity" });
}

async function main(): Promise<void> {
  testLegacySignatureBytesStayStable();
  testRequestIdIsBoundIntoSignature();
  testNodeKeyRotationIsNodeAndGenerationScoped();
  await testReplayGuardBoundsCollisionsAndExpiry();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
