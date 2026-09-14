import type { KeyLike } from "node:crypto";

export const MANDATORY_FORWARD_SCOPES: readonly string[];
export const COMPENSATION_SCOPES: readonly string[];
export const EMERGENCY_SCOPES: readonly string[];
export const COMPENSATION_PAIRINGS: Readonly<Record<string, string>>;

export interface Gate6ValidationOptions {
  now?: Date;
  installedSchemaMaximum: number;
  publicKeys: Readonly<Record<string, KeyLike | string | Buffer>>;
  expectedKeyId?: string;
  worstCaseRollbackMinutes?: number;
  expectedAttestation?: Readonly<{
    repository?: string;
    environment?: string;
    issuer?: string;
    audience?: string;
    signerWorkflowPath?: string;
    signerWorkflowSha?: string;
    workflowFileSha256?: string;
  }>;
  expectedBindings?: Readonly<Record<string, unknown>>;
}

export type Gate6ValidationResult =
  | { ok: true; envelopeCoreSha256: string; actionIndexSha256: string }
  | { ok: false; error: string };

export function canonicalGate6Json(value: unknown): string;
export function createGate6EnvelopeCore(input: Record<string, unknown>): Record<string, unknown>;
export function createGate6ActionIndex(actions: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>>;
export function validateGate6Envelope(value: unknown, options: Gate6ValidationOptions): Gate6ValidationResult;
