import { randomUUID } from "node:crypto";

import { createInternalSignature } from "./internal-auth.js";
import type {
  ActiveProductionFaultContext,
  ProductionFaultControlClient,
  ProductionFaultService,
} from "./production-canary-fault.js";

const GATE6_CONTROL_ORIGIN = "http://gate6-control:3006";
const GATE6_CONTROL_CONTEXT_PATH = "/internal/gate6/fault-context";
const GATE6_CONTROL_CONSUME_PATH = "/internal/gate6/fault-permits/consume";

export interface Gate6ControlClientOptions {
  nodeId: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  requestId?: () => string;
  requestTimeoutMs?: number;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export class Gate6ControlClient implements ProductionFaultControlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: Gate6ControlClientOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(options.nodeId)) {
      throw new Error("Gate 6 control client node ID is invalid");
    }
    if (options.sharedSecret.trim().length < 32) {
      throw new Error("Gate 6 control client node secret is invalid");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1500;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Gate 6 control client timeout is invalid");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private authHeaders(path: string, body: string): Record<string, string> {
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    const requestId = this.options.requestId?.() ?? randomUUID();
    return {
      "x-spx-node-id": this.options.nodeId,
      "x-spx-timestamp": timestamp,
      "x-spx-request-id": requestId,
      "x-spx-signature": createInternalSignature({
        body,
        timestamp,
        nodeId: this.options.nodeId,
        path,
        secret: this.options.sharedSecret,
        requestId,
      }),
    };
  }

  async getActiveContext(gate6Id: string): Promise<ActiveProductionFaultContext | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gate6Id)) return null;
    const path = `${GATE6_CONTROL_CONTEXT_PATH}/${encodeURIComponent(gate6Id)}`;
    const response = await this.fetchImpl(`${GATE6_CONTROL_ORIGIN}${path}`, {
      method: "GET",
      headers: this.authHeaders(path, "{}"),
      signal: timeoutSignal(this.requestTimeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Gate 6 control context is unavailable");
    return response.json() as Promise<ActiveProductionFaultContext>;
  }

  async consumePermit(input: {
    permitId: string;
    service: ProductionFaultService;
    teamId: number;
    signedPermitSha256: string;
    targetSha256?: string;
    fixtureSha256?: string;
  }): Promise<boolean> {
    const body = JSON.stringify({
      permitId: input.permitId,
      service: input.service,
      teamId: input.teamId,
      signedPermitSha256: input.signedPermitSha256,
      targetSha256: input.targetSha256 ?? null,
      fixtureSha256: input.fixtureSha256 ?? null,
    });
    const response = await this.fetchImpl(`${GATE6_CONTROL_ORIGIN}${GATE6_CONTROL_CONSUME_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(GATE6_CONTROL_CONSUME_PATH, body),
      },
      body,
      signal: timeoutSignal(this.requestTimeoutMs),
    });
    if (response.status === 404 || response.status === 409) return false;
    if (!response.ok) throw new Error("Gate 6 permit consumption is unavailable");
    return true;
  }
}
