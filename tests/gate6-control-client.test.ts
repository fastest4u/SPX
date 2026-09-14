import assert from "node:assert/strict";

import { Gate6ControlClient } from "../src/services/gate6-control-client.js";
import { verifyInternalSignature } from "../src/services/internal-auth.js";

const NODE_ID = "prod-line-service-1";
const SECRET = "line-gate6-node-secret-value-00001";
const NOW = new Date("2026-07-11T12:00:00.000Z");

async function main(): Promise<void> {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let requestSequence = 0;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("fault-context")) {
      return new Response(JSON.stringify({
        gate6Id: "gate6-prod-001",
        gate6Nonce: "nonce-prod-001",
        envelopeCoreSha256: "a".repeat(64),
        permitId: "permit-line-001",
        actionId: "task9-line-001",
        signedPermitSha256: "d".repeat(64),
        currentStage: "db-transition-stable",
        acceptedCheckerSha256: "b".repeat(64),
        teamId: 2,
        candidateSha: "c".repeat(40),
        repository: "owner/SPX",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ status: "consumed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new Gate6ControlClient({
    nodeId: NODE_ID,
    sharedSecret: SECRET,
    now: () => NOW,
    requestId: () => `gate6-client-${++requestSequence}`,
    fetchImpl: fetchImpl as typeof fetch,
  } as never);

  const context = await client.getActiveContext("gate6-prod-001");
  assert.equal(context?.teamId, 2);
  const getRequest = requests[0];
  assert.ok(getRequest);
  const getHeaders = new Headers(getRequest.init.headers);
  const getPath = "/internal/gate6/fault-context/gate6-prod-001";
  assert.equal(getHeaders.get("x-spx-node-id"), NODE_ID);
  assert.equal(verifyInternalSignature({
    body: "{}",
    timestamp: getHeaders.get("x-spx-timestamp") ?? "",
    nodeId: NODE_ID,
    path: getPath,
    secret: SECRET,
    requestId: getHeaders.get("x-spx-request-id") ?? "",
    signature: getHeaders.get("x-spx-signature") ?? "",
    now: NOW,
  }).ok, true);

  assert.equal(await client.consumePermit({
    permitId: "permit-line-001",
    service: "line-service",
    teamId: 2,
    targetSha256: "d".repeat(64),
    signedPermitSha256: "e".repeat(64),
  }), true);
  const postRequest = requests[1];
  assert.ok(postRequest);
  const postHeaders = new Headers(postRequest.init.headers);
  const postBody = String(postRequest.init.body);
  assert.equal(JSON.parse(postBody).signedPermitSha256, "e".repeat(64));
  assert.equal(verifyInternalSignature({
    body: postBody,
    timestamp: postHeaders.get("x-spx-timestamp") ?? "",
    nodeId: NODE_ID,
    path: "/internal/gate6/fault-permits/consume",
    secret: SECRET,
    requestId: postHeaders.get("x-spx-request-id") ?? "",
    signature: postHeaders.get("x-spx-signature") ?? "",
    now: NOW,
  }).ok, true);

  console.log("gate6 control client tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
