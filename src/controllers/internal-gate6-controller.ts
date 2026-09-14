import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { ActiveProductionFaultContext, ProductionFaultService } from "../services/production-canary-fault.js";
import {
  InternalRequestReplayGuard,
  type InternalRequestReplayStore,
  type NodeSecretKeyRing,
  verifyInternalNodeSignature,
} from "../services/internal-auth.js";

export interface InternalGate6Repository {
  getActiveFaultContext(input: {
    gate6Id: string;
    service: ProductionFaultService;
    repository: string;
    now?: Date;
  }): Promise<ActiveProductionFaultContext | null>;
  consumeTask9Permit(input: {
    permitId: string;
    service: ProductionFaultService;
    teamId: number;
    signedPermitSha256: string;
    targetSha256?: string;
    fixtureSha256?: string;
    now?: Date;
  }): Promise<{ status: "consumed" }>;
}

interface InternalGate6ControllerOptions {
  repository: InternalGate6Repository;
  repositoryName: string;
  lineNodeSecrets: ReadonlyMap<string, NodeSecretKeyRing>;
  ocrNodeSecrets: ReadonlyMap<string, NodeSecretKeyRing>;
  replayGuard?: InternalRequestReplayStore;
  now?: () => Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const internalGate6Controller: FastifyPluginAsync<InternalGate6ControllerOptions> = async (
  app,
  options,
) => {
  const replayGuard = options.replayGuard ?? new InternalRequestReplayGuard();

  async function authenticate(
    request: FastifyRequest,
    rawBody: string,
  ): Promise<ProductionFaultService | null> {
    const nodeId = firstHeader(request.headers["x-spx-node-id"]);
    const timestamp = firstHeader(request.headers["x-spx-timestamp"]);
    const requestId = firstHeader(request.headers["x-spx-request-id"]);
    const signature = firstHeader(request.headers["x-spx-signature"]);
    if (!nodeId || !timestamp || !requestId || !signature) return null;

    const isLine = options.lineNodeSecrets.has(nodeId);
    const isOcr = options.ocrNodeSecrets.has(nodeId);
    if (isLine === isOcr) return null;
    const service: ProductionFaultService = isLine ? "line-service" : "ocr-service";
    const nodeSecrets = isLine ? options.lineNodeSecrets : options.ocrNodeSecrets;
    const now = options.now?.() ?? new Date();
    const verified = verifyInternalNodeSignature({
      body: rawBody,
      timestamp,
      nodeId,
      path: request.url,
      signature,
      requestId,
      nodeSecrets,
      now,
    });
    if (!verified.ok) return null;
    const replay = await replayGuard.consume({
      nodeId,
      requestId,
      signedTimestamp: timestamp,
      partition: "gate6-control",
      now,
    });
    return replay.ok ? service : null;
  }

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/gate6/fault-context/:gate6Id", async (request, reply) => {
    const service = await authenticate(request, "{}");
    if (!service) return reply.code(404).send();
    const gate6Id = (request.params as { gate6Id?: string }).gate6Id;
    if (!gate6Id) return reply.code(404).send();
    const context = await options.repository.getActiveFaultContext({
      gate6Id,
      service,
      repository: options.repositoryName,
      now: options.now?.(),
    });
    if (!context) return reply.code(404).send();
    return reply.send(context);
  });

  app.post("/gate6/fault-permits/consume", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const service = await authenticate(request, rawBody);
    if (!service) return reply.code(404).send();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return reply.code(404).send();
    }
    const body = record(parsed);
    const keys = body ? Object.keys(body).sort() : [];
    if (
      !body
      || ![
        "fixtureSha256", "permitId", "service", "signedPermitSha256", "targetSha256", "teamId",
      ].every((key) => keys.includes(key))
      || keys.length !== 6
      || typeof body.permitId !== "string"
      || typeof body.signedPermitSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(body.signedPermitSha256)
      || body.service !== service
      || !Number.isSafeInteger(body.teamId)
      || Number(body.teamId) <= 0
    ) {
      return reply.code(404).send();
    }
    try {
      await options.repository.consumeTask9Permit({
        permitId: body.permitId,
        service,
        teamId: body.teamId as number,
        signedPermitSha256: body.signedPermitSha256,
        targetSha256: typeof body.targetSha256 === "string" ? body.targetSha256 : undefined,
        fixtureSha256: typeof body.fixtureSha256 === "string" ? body.fixtureSha256 : undefined,
        now: options.now?.(),
      });
      return reply.send({ status: "consumed" });
    } catch {
      return reply.code(404).send();
    }
  });
};
