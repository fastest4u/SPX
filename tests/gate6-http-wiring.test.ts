import assert from "node:assert/strict";

import { env } from "../src/config/env.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { createHttpServer } from "../src/services/http-server.js";

const NODE_ID = "prod-line-service-1";
const SECRET = "line-gate6-node-secret-value-00001";
const REPOSITORY = "owner/SPX";

async function main(): Promise<void> {
  const mutableEnv = env as unknown as Record<string, unknown>;
  const original = {
    repository: env.GATE6_REPOSITORY,
    line: env.GATE6_LINE_NODE_SECRETS,
    ocr: env.GATE6_OCR_NODE_SECRETS,
  };
  mutableEnv.GATE6_REPOSITORY = REPOSITORY;
  mutableEnv.GATE6_LINE_NODE_SECRETS = new Map([[NODE_ID, { active: SECRET }]]);
  mutableEnv.GATE6_OCR_NODE_SECRETS = new Map([[
    "prod-ocr-service-1",
    { active: "ocr-gate6-node-secret-value-000002" },
  ]]);
  const app = await createHttpServer({
    surface: "gate6-control",
    role: "gate6-control",
    probeDatabaseReady: async () => true,
    gate6Repository: {
      async getActiveFaultContext(input) {
        return {
          gate6Id: input.gate6Id,
          gate6Nonce: "nonce-prod-001",
          envelopeCoreSha256: "a".repeat(64),
          permitId: "permit-line-001",
          actionId: "task9-line-001",
          signedPermitSha256: "d".repeat(64),
          currentStage: "db-transition-stable",
          acceptedCheckerSha256: "b".repeat(64),
          teamId: 2,
          candidateSha: "c".repeat(40),
          repository: input.repository,
        };
      },
      async consumeTask9Permit() { return { status: "consumed" }; },
    },
  });
  try {
    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().data.service, "gate6-control");

    const path = "/internal/gate6/fault-context/gate6-prod-001";
    const timestamp = new Date().toISOString();
    const requestId = "gate6-http-wiring-001";
    const context = await app.inject({
      method: "GET",
      url: path,
      headers: {
        "x-spx-node-id": NODE_ID,
        "x-spx-timestamp": timestamp,
        "x-spx-request-id": requestId,
        "x-spx-signature": createInternalSignature({
          body: "{}",
          timestamp,
          nodeId: NODE_ID,
          path,
          secret: SECRET,
          requestId,
        }),
      },
    });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(context.json().teamId, 2);
    assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 404);
  } finally {
    await app.close();
    mutableEnv.GATE6_REPOSITORY = original.repository;
    mutableEnv.GATE6_LINE_NODE_SECRETS = original.line;
    mutableEnv.GATE6_OCR_NODE_SECRETS = original.ocr;
  }
  console.log("gate6 HTTP wiring tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
