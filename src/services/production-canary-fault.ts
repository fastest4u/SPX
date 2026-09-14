import { createHash, verify, type KeyLike } from "node:crypto";

import { canonicalGate6Json } from "./gate6-approval-runtime.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PERMIT_TTL_MS = 2 * 60 * 1000;

export type ProductionFaultService = "line-service" | "ocr-service";

export interface ActiveProductionFaultContext {
  gate6Id: string;
  gate6Nonce: string;
  envelopeCoreSha256: string;
  permitId: string;
  actionId: string;
  signedPermitSha256: string;
  currentStage: string;
  acceptedCheckerSha256: string;
  teamId: number;
  candidateSha: string;
  repository: string;
}

export interface VerifyProductionFaultPermitOptions {
  service: ProductionFaultService;
  keyId: string;
  publicKey: KeyLike | string | Buffer;
  activeContext: ActiveProductionFaultContext;
  signerWorkflowSha: string;
  expectedRequestSha256: string;
  now?: Date;
}

export type ProductionFaultPermitResult =
  | {
      ok: true;
      permitId: string;
      actionId: string;
      service: ProductionFaultService;
      signedPermitSha256: string;
    }
  | { ok: false; code: "permit-unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("fault permit fields are invalid");
  }
}

function string(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function date(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) throw new Error(`${label} is invalid`);
  return result;
}

export function canonicalFaultPermitJson(value: unknown): string {
  return canonicalGate6Json(value);
}

export function verifyProductionFaultPermit(
  permitValue: unknown,
  options: VerifyProductionFaultPermitOptions,
): ProductionFaultPermitResult {
  try {
    if (!isRecord(permitValue)) throw new Error("fault permit is invalid");
    exactKeys(permitValue, [
      "schemaVersion", "permitId", "gate6Id", "gate6Nonce", "envelopeCoreSha256",
      "actionId", "actionSha256", "candidateSha", "service", "kind", "teamId",
      "targetSha256", "fixtureSha256", "releaseOrFixtureSha256", "issuanceNonce",
      "currentStage", "acceptedCheckerSha256",
      "oneMatch", "issuedAt", "expiresAt", "githubAttestation", "signature",
    ]);
    if (permitValue.schemaVersion !== 1 || permitValue.kind !== "retryable-before-provider") {
      throw new Error("fault permit version or kind is invalid");
    }
    const permitId = string(permitValue.permitId, ID, "fault permit ID");
    const actionId = string(permitValue.actionId, ID, "fault action ID");
    string(permitValue.actionSha256, SHA256, "fault action hash");
    string(permitValue.envelopeCoreSha256, SHA256, "envelope core hash");
    string(permitValue.acceptedCheckerSha256, SHA256, "accepted checker hash");
    string(permitValue.releaseOrFixtureSha256, SHA256, "release or fixture hash");
    string(permitValue.issuanceNonce, ID, "fault permit issuance nonce");
    string(permitValue.candidateSha, SHA, "candidate SHA");
    if (
      permitValue.service !== options.service
      || permitId !== options.activeContext.permitId
      || actionId !== options.activeContext.actionId
      || permitValue.gate6Id !== options.activeContext.gate6Id
      || permitValue.gate6Nonce !== options.activeContext.gate6Nonce
      || permitValue.envelopeCoreSha256 !== options.activeContext.envelopeCoreSha256
      || permitValue.currentStage !== "db-transition-stable"
      || permitValue.currentStage !== options.activeContext.currentStage
      || permitValue.acceptedCheckerSha256 !== options.activeContext.acceptedCheckerSha256
      || permitValue.teamId !== options.activeContext.teamId
      || permitValue.candidateSha !== options.activeContext.candidateSha
      || permitValue.oneMatch !== 1
    ) throw new Error("fault permit active-run binding mismatch");
    string(options.expectedRequestSha256, SHA256, "fault request hash");
    if (options.service === "line-service") {
      if (permitValue.targetSha256 !== options.expectedRequestSha256 || permitValue.fixtureSha256 !== null) {
        throw new Error("LINE fault permit request mismatch");
      }
    } else if (
      permitValue.fixtureSha256 !== options.expectedRequestSha256
      || permitValue.targetSha256 !== null
    ) throw new Error("OCR fault permit request mismatch");
    const issuedAt = date(permitValue.issuedAt, "fault permit issuance");
    const expiresAt = date(permitValue.expiresAt, "fault permit expiry");
    const now = (options.now ?? new Date()).getTime();
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_PERMIT_TTL_MS || now < issuedAt || now >= expiresAt) {
      throw new Error("fault permit TTL is invalid");
    }

    if (!isRecord(permitValue.githubAttestation)) throw new Error("fault permit attestation is invalid");
    exactKeys(permitValue.githubAttestation, [
      "repository", "environment", "jobWorkflowRef", "jobWorkflowSha", "issuer", "audience",
    ]);
    const serviceName = options.service === "line-service" ? "line" : "ocr";
    string(options.signerWorkflowSha, SHA, "fault permit signer workflow SHA");
    const expectedWorkflow = `${options.activeContext.repository}/.github/workflows/gate6-${serviceName}-permit-signer.yml@${options.signerWorkflowSha}`;
    if (
      permitValue.githubAttestation.repository !== options.activeContext.repository
      || permitValue.githubAttestation.environment !== "production"
      || permitValue.githubAttestation.jobWorkflowRef !== expectedWorkflow
      || permitValue.githubAttestation.jobWorkflowSha !== options.signerWorkflowSha
      || permitValue.githubAttestation.issuer !== "https://token.actions.githubusercontent.com"
      || permitValue.githubAttestation.audience !== `spx-gate6-${serviceName}-permit`
    ) throw new Error("fault permit attestation mismatch");

    if (!isRecord(permitValue.signature)) throw new Error("fault permit signature is invalid");
    exactKeys(permitValue.signature, ["algorithm", "keyId", "signedPayloadSha256", "signatureBase64"]);
    if (permitValue.signature.algorithm !== "ed25519" || permitValue.signature.keyId !== options.keyId) {
      throw new Error("fault permit verification key mismatch");
    }
    const { signature, ...payload } = permitValue;
    const canonical = canonicalFaultPermitJson(payload);
    const payloadSha256 = createHash("sha256").update(canonical).digest("hex");
    if (signature.signedPayloadSha256 !== payloadSha256 || typeof signature.signatureBase64 !== "string") {
      throw new Error("fault permit signed payload mismatch");
    }
    const bytes = Buffer.from(signature.signatureBase64, "base64");
    if (bytes.byteLength !== 64 || !verify(null, Buffer.from(canonical), options.publicKey, bytes)) {
      throw new Error("fault permit signature verification failed");
    }
    const signedPermitSha256 = createHash("sha256")
      .update(canonicalFaultPermitJson(permitValue))
      .digest("hex");
    if (
      !SHA256.test(options.activeContext.signedPermitSha256)
      || signedPermitSha256 !== options.activeContext.signedPermitSha256
    ) throw new Error("fault permit does not match the durably registered permit");
    return {
      ok: true,
      permitId,
      actionId,
      service: options.service,
      signedPermitSha256,
    };
  } catch {
    return { ok: false, code: "permit-unavailable" };
  }
}

export function sha256FaultRequest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ProductionFaultControlClient {
  getActiveContext(gate6Id: string): Promise<ActiveProductionFaultContext | null>;
  consumePermit(input: {
    permitId: string;
    service: ProductionFaultService;
    teamId: number;
    signedPermitSha256: string;
    targetSha256?: string;
    fixtureSha256?: string;
  }): Promise<boolean>;
}

export interface ProductionCanaryFaultGate {
  shouldInjectLine(input: { encodedPermit: string | undefined; targetId: string }): Promise<boolean>;
  shouldInjectOcr(input: { encodedPermit: string | undefined; fixtureBytes: Buffer }): Promise<boolean>;
}

function decodeCanonicalPermit(encoded: string): Record<string, unknown> | null {
  try {
    const text = Buffer.from(encoded, "base64").toString("utf8");
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || canonicalFaultPermitJson(value) !== text) return null;
    return value;
  } catch {
    return null;
  }
}

export function createProductionCanaryFaultGate(input: {
  service: ProductionFaultService;
  keyId: string;
  publicKey: KeyLike | string | Buffer;
  signerWorkflowSha: string;
  controlClient: ProductionFaultControlClient;
  now?: () => Date;
}): ProductionCanaryFaultGate {
  if (!SHA.test(input.signerWorkflowSha)) {
    throw new Error("production canary fault signer workflow SHA is invalid");
  }
  async function attempt(encodedPermit: string | undefined, expectedRequestSha256: string): Promise<boolean> {
    if (!encodedPermit) return false;
    const permit = decodeCanonicalPermit(encodedPermit);
    if (!permit || typeof permit.gate6Id !== "string") return false;
    try {
      const activeContext = await input.controlClient.getActiveContext(permit.gate6Id);
      if (!activeContext) return false;
      const verified = verifyProductionFaultPermit(permit, {
        service: input.service,
        keyId: input.keyId,
        publicKey: input.publicKey,
        activeContext,
        signerWorkflowSha: input.signerWorkflowSha,
        expectedRequestSha256,
        now: input.now?.(),
      });
      if (!verified.ok) return false;
      return await input.controlClient.consumePermit({
        permitId: verified.permitId,
        service: input.service,
        teamId: activeContext.teamId,
        signedPermitSha256: verified.signedPermitSha256,
        ...(input.service === "line-service"
          ? { targetSha256: expectedRequestSha256 }
          : { fixtureSha256: expectedRequestSha256 }),
      });
    } catch {
      return false;
    }
  }
  return Object.freeze({
    shouldInjectLine({ encodedPermit, targetId }: { encodedPermit: string | undefined; targetId: string }) {
      if (input.service !== "line-service") return Promise.resolve(false);
      return attempt(encodedPermit, sha256FaultRequest(targetId));
    },
    shouldInjectOcr({ encodedPermit, fixtureBytes }: { encodedPermit: string | undefined; fixtureBytes: Buffer }) {
      if (input.service !== "ocr-service") return Promise.resolve(false);
      return attempt(encodedPermit, sha256FaultRequest(fixtureBytes));
    },
  });
}
