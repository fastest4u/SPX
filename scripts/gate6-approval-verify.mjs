#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalGate6Json,
  validateGate6Envelope,
} from "../src/services/gate6-approval-runtime.mjs";
import { readEvidenceBytes } from "./lib/evidence-artifact.mjs";

const DEFAULT_CHECKSUMS_PATH = fileURLToPath(
  new URL("../migrations/released-checksums.json", import.meta.url),
);

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("invalid Gate 6 verifier arguments");
    values[match[1]] = match[2];
  }
  const allowed = new Set([
    "envelope",
    "public-key",
    "key-id",
    "released-checksums",
    "repository",
    "signer-workflow-sha",
    "workflow-file-sha256",
    "now",
  ]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error("unknown Gate 6 verifier argument");
  for (const key of [
    "envelope",
    "public-key",
    "key-id",
    "repository",
    "signer-workflow-sha",
    "workflow-file-sha256",
  ]) {
    if (!values[key]) throw new Error("missing Gate 6 verifier argument");
  }
  return values;
}

function releasedSchemaMaximum(checksums) {
  if (checksums === null || typeof checksums !== "object" || Array.isArray(checksums)) {
    throw new Error("released migration checksum registry is invalid");
  }
  const versions = Object.keys(checksums).map((name) => {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match || !/^[0-9a-f]{64}$/.test(checksums[name])) {
      throw new Error("released migration checksum entry is invalid");
    }
    return Number.parseInt(match[1], 10);
  });
  if (versions.length === 0) throw new Error("released migration checksum registry is empty");
  return Math.max(...versions);
}

async function readCanonicalJson(path, label) {
  const bytes = await readEvidenceBytes(resolve(path));
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (text !== canonicalGate6Json(value)) throw new Error(`${label} must use canonical JSON`);
  return value;
}

export async function verifyGate6ApprovalFile(input) {
  const envelope = await readCanonicalJson(input.envelopePath, "Gate 6 envelope");
  const checksumPath = input.releasedChecksumsPath ?? DEFAULT_CHECKSUMS_PATH;
  const checksums = JSON.parse(await readFile(resolve(checksumPath), "utf8"));
  const publicKey = await readFile(resolve(input.publicKeyPath), "utf8");
  const result = validateGate6Envelope(envelope, {
    now: input.now,
    installedSchemaMaximum: releasedSchemaMaximum(checksums),
    publicKeys: { [input.keyId]: publicKey },
    expectedAttestation: {
      repository: input.repository,
      environment: "production",
      issuer: "https://token.actions.githubusercontent.com",
      audience: "spx-gate6",
      signerWorkflowPath: `${input.repository}/.github/workflows/gate6-envelope-signer.yml`,
      signerWorkflowSha: input.signerWorkflowSha,
      workflowFileSha256: input.workflowFileSha256,
    },
  });
  if (!result.ok) throw new Error("Gate 6 approval verification failed");
  return {
    ok: true,
    gate6Id: envelope.gate6Id,
    envelopeCoreSha256: result.envelopeCoreSha256,
    actionIndexSha256: result.actionIndexSha256,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await verifyGate6ApprovalFile({
      envelopePath: args.envelope,
      publicKeyPath: args["public-key"],
      keyId: args["key-id"],
      releasedChecksumsPath: args["released-checksums"],
      repository: args.repository,
      signerWorkflowSha: args["signer-workflow-sha"],
      workflowFileSha256: args["workflow-file-sha256"],
      now: args.now ? new Date(args.now) : undefined,
    });
    process.stdout.write(`${canonicalGate6Json(result)}\n`);
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-approval-invalid" })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
