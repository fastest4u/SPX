import assert from "node:assert/strict";
import { createInternalSignature, verifyInternalSignature } from "../src/services/internal-auth.js";

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
