import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { internalGate6Controller } from "../src/controllers/internal-gate6-controller.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import {
  httpSurfaceForRole,
  parseRuntimeRole,
  requireNodeIdForDistributedRole,
  roleUsesDatabase,
} from "../src/services/runtime-role.js";
import { buildRuntimeStartupPlan } from "../src/services/runtime-startup-plan.js";

const LINE_NODE_ID = "prod-line-service-1";
const OCR_NODE_ID = "prod-ocr-service-1";
const LINE_SECRET = "line-gate6-node-secret-value-00001";
const OCR_SECRET = "ocr-gate6-node-secret-value-000002";
const REPOSITORY = "owner/SPX";

function signedHeaders(input: {
  nodeId: string;
  secret: string;
  path: string;
  body: string;
  requestId: string;
}): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    "x-spx-node-id": input.nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-request-id": input.requestId,
    "x-spx-signature": createInternalSignature({
      body: input.body,
      timestamp,
      nodeId: input.nodeId,
      path: input.path,
      secret: input.secret,
      requestId: input.requestId,
    }),
  };
}

async function buildApp(): Promise<{
  app: FastifyInstance;
  consumed: Array<{ permitId: string; service: string; signedPermitSha256: string }>;
}> {
  const app = Fastify();
  const consumed: Array<{ permitId: string; service: string; signedPermitSha256: string }> = [];
  const repository = {
    async getActiveFaultContext(input: {
      gate6Id: string;
      service: "line-service" | "ocr-service";
      repository: string;
    }) {
      if (input.gate6Id !== "gate6-prod-001" || input.repository !== REPOSITORY) return null;
      return {
        gate6Id: input.gate6Id,
        gate6Nonce: "nonce-prod-001",
        envelopeCoreSha256: "a".repeat(64),
        permitId: input.service === "line-service" ? "permit-line-001" : "permit-ocr-001",
        actionId: input.service === "line-service" ? "task9-line-001" : "task9-ocr-001",
        signedPermitSha256: "d".repeat(64),
        currentStage: "db-transition-stable",
        acceptedCheckerSha256: "b".repeat(64),
        teamId: input.service === "line-service" ? 2 : 3,
        candidateSha: "c".repeat(40),
        repository: input.repository,
      };
    },
    async consumeTask9Permit(input: {
      permitId: string;
      service: string;
      signedPermitSha256: string;
    }) {
      consumed.push({
        permitId: input.permitId,
        service: input.service,
        signedPermitSha256: input.signedPermitSha256,
      });
      return { status: "consumed" as const };
    },
  };
  await app.register(internalGate6Controller, {
    prefix: "/internal",
    repository,
    repositoryName: REPOSITORY,
    lineNodeSecrets: new Map([[LINE_NODE_ID, { active: LINE_SECRET }]]),
    ocrNodeSecrets: new Map([[OCR_NODE_ID, { active: OCR_SECRET }]]),
  } as never);
  return { app, consumed };
}

async function main(): Promise<void> {
  assert.equal(parseRuntimeRole("gate6-control"), "gate6-control");
  assert.equal(httpSurfaceForRole("gate6-control"), "gate6-control");
  assert.equal(roleUsesDatabase("gate6-control"), true);
  assert.throws(
    () => requireNodeIdForDistributedRole("gate6-control", ""),
    /SPX_NODE_ID/,
  );
  const startup = buildRuntimeStartupPlan({
    role: "gate6-control",
    runTeamIds: [],
    dryRunWorkerEnabled: true,
    realWorkerEnabled: true,
    settlementWorkerEnabled: true,
  });
  assert.equal(startup.httpSurface, "gate6-control");
  assert.equal(startup.runHttp, true);
  assert.equal(startup.runTeamRuntimeManager, false);
  assert.equal(startup.runAutoAcceptDryRunLoop, false);
  assert.equal(startup.runAutoAcceptRealLoop, false);
  assert.equal(startup.runAutoAcceptSettlementLoop, false);
  const appSource = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
  assert.match(
    appSource,
    /env\.SPX_ROLE !== "gate6-control"[\s\S]*roleUsesDatabase\(env\.SPX_ROLE\)/,
    "gate6-control must not query DB-backed application settings outside its four-table grant",
  );

  const { app, consumed } = await buildApp();
  try {
    const contextPath = "/internal/gate6/fault-context/gate6-prod-001";
    const lineContext = await app.inject({
      method: "GET",
      url: contextPath,
      headers: signedHeaders({
        nodeId: LINE_NODE_ID,
        secret: LINE_SECRET,
        path: contextPath,
        body: "{}",
        requestId: "line-context-001",
      }),
    });
    assert.equal(lineContext.statusCode, 200, lineContext.body);
    assert.equal(lineContext.json().teamId, 2);

    const unknownContext = await app.inject({
      method: "GET",
      url: contextPath,
      headers: signedHeaders({
        nodeId: "unknown-line-node",
        secret: LINE_SECRET,
        path: contextPath,
        body: "{}",
        requestId: "unknown-context-001",
      }),
    });
    assert.equal(unknownContext.statusCode, 404);

    const consumePath = "/internal/gate6/fault-permits/consume";
    const crossServiceBody = JSON.stringify({
      permitId: "permit-ocr-001",
      service: "ocr-service",
      teamId: 3,
      targetSha256: null,
      fixtureSha256: "d".repeat(64),
      signedPermitSha256: "f".repeat(64),
    });
    const crossService = await app.inject({
      method: "POST",
      url: consumePath,
      headers: {
        "content-type": "application/json",
        ...signedHeaders({
          nodeId: LINE_NODE_ID,
          secret: LINE_SECRET,
          path: consumePath,
          body: crossServiceBody,
          requestId: "cross-service-001",
        }),
      },
      payload: crossServiceBody,
    });
    assert.equal(crossService.statusCode, 404);
    assert.equal(consumed.length, 0);

    const lineBody = JSON.stringify({
      permitId: "permit-line-001",
      service: "line-service",
      teamId: 2,
      targetSha256: "e".repeat(64),
      fixtureSha256: null,
      signedPermitSha256: "d".repeat(64),
    });
    const lineHeaders = {
      "content-type": "application/json",
      ...signedHeaders({
        nodeId: LINE_NODE_ID,
        secret: LINE_SECRET,
        path: consumePath,
        body: lineBody,
        requestId: "line-consume-001",
      }),
    };
    const consumedOnce = await app.inject({
      method: "POST",
      url: consumePath,
      headers: lineHeaders,
      payload: lineBody,
    });
    assert.equal(consumedOnce.statusCode, 200, consumedOnce.body);
    assert.deepEqual(consumed, [{
      permitId: "permit-line-001",
      service: "line-service",
      signedPermitSha256: "d".repeat(64),
    }]);

    const replay = await app.inject({
      method: "POST",
      url: consumePath,
      headers: lineHeaders,
      payload: lineBody,
    });
    assert.equal(replay.statusCode, 404);
    assert.equal(consumed.length, 1);
  } finally {
    await app.close();
  }

  console.log("gate6 runtime integration tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
