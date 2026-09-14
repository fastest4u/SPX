import { createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  canonicalGate6Json,
  validateGate6Envelope,
} from "../../src/services/gate6-approval-runtime.mjs";
import {
  authorizeGate6ForwardMutation,
  completeGate6MutationContext,
} from "./gate6-controller.mjs";
import { createGate6MysqlLedger, createProductionGate6MysqlPool } from "./gate6-mysql-ledger.mjs";
import { readEvidenceBytes } from "./evidence-artifact.mjs";

const KEYRING_FILE = "/run/config/gate6-production-keyring.json";
const CHECKSUMS_FILE = resolve("migrations/released-checksums.json");
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYRING_ROLES = Object.freeze(["envelope", "linePermit", "ocrPermit", "postproof"]);

export function isValidProductionGate6Keyring(keyring) {
  if (
    keyring === null
    || typeof keyring !== "object"
    || Array.isArray(keyring)
    || Object.keys(keyring).sort().join("\0") !== [
      "keyIds",
      "keys",
      "repository",
      "schemaVersion",
      "signerWorkflowShas",
      "workflowFileSha256",
    ].join("\0")
    || keyring.schemaVersion !== 2
    || keyring.keys === null
    || typeof keyring.keys !== "object"
    || Array.isArray(keyring.keys)
    || keyring.keyIds === null
    || typeof keyring.keyIds !== "object"
    || Array.isArray(keyring.keyIds)
    || keyring.signerWorkflowShas === null
    || typeof keyring.signerWorkflowShas !== "object"
    || Array.isArray(keyring.signerWorkflowShas)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(keyring.repository ?? "")
    || !/^[0-9a-f]{64}$/.test(keyring.workflowFileSha256 ?? "")
  ) return false;
  const actualRoles = Object.keys(keyring.keyIds).sort();
  const actualSignerRoles = Object.keys(keyring.signerWorkflowShas).sort();
  const expectedRoles = [...KEYRING_ROLES].sort();
  if (
    actualRoles.length !== expectedRoles.length
    || actualRoles.some((role, index) => role !== expectedRoles[index])
    || actualSignerRoles.length !== expectedRoles.length
    || actualSignerRoles.some((role, index) => role !== expectedRoles[index])
    || !KEYRING_ROLES.every((role) => /^[0-9a-f]{40}$/.test(keyring.signerWorkflowShas[role]))
  ) return false;
  const keyIds = KEYRING_ROLES.map((role) => keyring.keyIds[role]);
  if (
    !keyIds.every((keyId) => KEY_ID.test(keyId ?? "") && typeof keyring.keys[keyId] === "string")
    || new Set(keyIds).size !== keyIds.length
    || Object.keys(keyring.keys).sort().join("\0") !== [...keyIds].sort().join("\0")
  ) return false;
  try {
    const fingerprints = keyIds.map((keyId) => {
      const encoded = keyring.keys[keyId];
      if (!encoded.startsWith("-----BEGIN PUBLIC KEY-----\n")) {
        throw new Error("Gate 6 role key is not a public SPKI PEM");
      }
      const key = createPublicKey(encoded);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Gate 6 role key is not Ed25519");
      if (key.export({ type: "spki", format: "pem" }).toString() !== encoded) {
        throw new Error("Gate 6 role key is not canonical public SPKI PEM");
      }
      const der = key.export({ type: "spki", format: "der" });
      return createHash("sha256").update(der).digest("hex");
    });
    return new Set(fingerprints).size === fingerprints.length;
  } catch {
    return false;
  }
}

export function parseGate6ControllerArgs(argv, options) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("invalid Gate 6 controller arguments");
    values[match[1]] = match[2];
  }
  const allowed = new Set([
    "action", "envelope", "action-approval", "release",
    ...(options.extraArguments ?? []),
  ]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error("unknown Gate 6 controller argument");
  if (!options.actions.includes(values.action)) throw new Error("unknown Gate 6 controller action");
  for (const key of ["envelope", "release"]) if (!values[key]) throw new Error("missing Gate 6 controller artifact");
  if (!options.readOnlyActions?.includes(values.action) && !values["action-approval"]) {
    throw new Error("mutating Gate 6 controller action requires signed approval");
  }
  return values;
}

async function canonicalFile(path, label) {
  const bytes = await readEvidenceBytes(resolve(path));
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (text !== canonicalGate6Json(value)) throw new Error(`${label} must use canonical JSON`);
  return { value, bytes };
}

function releasedMaximum(checksums) {
  const versions = Object.keys(checksums).map((name) => Number.parseInt(name.slice(0, 3), 10));
  if (versions.some((value) => !Number.isSafeInteger(value))) throw new Error("released migration registry is invalid");
  return Math.max(...versions);
}

export async function loadVerifiedGate6ControllerArtifacts(args, expectedScopes, now = new Date()) {
  const [envelopeFile, releaseFile, keyringText, checksumText] = await Promise.all([
    canonicalFile(args.envelope, "Gate 6 envelope"),
    canonicalFile(args.release, "release manifest"),
    readFile(KEYRING_FILE, "utf8"),
    readFile(CHECKSUMS_FILE, "utf8"),
  ]);
  const envelope = envelopeFile.value;
  const release = releaseFile.value;
  const keyring = JSON.parse(keyringText);
  const checksums = JSON.parse(checksumText);
  if (!isValidProductionGate6Keyring(keyring)) {
    throw new Error("Gate 6 production keyring is invalid");
  }
  const repository = keyring.repository;
  const verification = validateGate6Envelope(envelope, {
    now,
    installedSchemaMaximum: releasedMaximum(checksums),
    publicKeys: keyring.keys,
    expectedKeyId: keyring.keyIds.envelope,
    expectedAttestation: {
      repository,
      environment: "production",
      issuer: "https://token.actions.githubusercontent.com",
      audience: "spx-gate6",
      signerWorkflowPath: `${repository}/.github/workflows/gate6-envelope-signer.yml`,
      signerWorkflowSha: keyring.signerWorkflowShas.envelope,
      workflowFileSha256: keyring.workflowFileSha256,
    },
  });
  if (!verification.ok) throw new Error("Gate 6 envelope verification failed");
  const releaseSha256 = createHash("sha256").update(releaseFile.bytes).digest("hex");
  if (
    releaseSha256 !== envelope.releaseManifestSha256
    || release.sourceSha !== envelope.candidateSha
    || release.imageId !== envelope.candidateImageDigest
    || release.schema?.max !== envelope.installedSchemaVersion
    || release.migrationSetSha256 !== envelope.installedMigrationSetSha256
  ) throw new Error("installed release manifest does not match the Gate 6 envelope");
  if (!args["action-approval"]) return { envelope, release, action: null, approvalSha256: null, keyring };
  const actionFile = await canonicalFile(args["action-approval"], "Gate 6 action approval");
  const action = actionFile.value;
  const indexed = envelope.actionApprovals.find((candidate) => candidate.actionId === action.actionId);
  if (!indexed || canonicalGate6Json(indexed) !== canonicalGate6Json(action)) {
    throw new Error("Gate 6 action approval is not the indexed signed action");
  }
  if (!expectedScopes.includes(action.scope)) throw new Error("Gate 6 action scope is not allowed by this controller");
  return {
    envelope,
    release,
    action,
    approvalSha256: createHash("sha256").update(actionFile.bytes).digest("hex"),
    keyring,
  };
}

export async function runVerifiedGate6ControllerReadOnly(input) {
  const now = input.now ?? new Date();
  const artifacts = input.artifacts ?? await (input.loadArtifacts ?? loadVerifiedGate6ControllerArtifacts)(
    input.args,
    input.expectedScopes ?? [],
    now,
  );
  const pool = input.pool ?? await (input.createPool ?? createProductionGate6MysqlPool)({
    runtime: input.databaseRuntime ?? "host",
    expectedTargetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
  });
  const ledger = input.ledger ?? createGate6MysqlLedger(pool);
  try {
    return await input.execute({ artifacts, ledger, pool, args: input.args, now });
  } finally {
    if (!input.pool && typeof pool?.end === "function") await pool.end();
  }
}

export async function runVerifiedGate6ControllerMutation(input) {
  const now = input.now ?? new Date();
  const artifacts = input.artifacts ?? await (input.loadArtifacts ?? loadVerifiedGate6ControllerArtifacts)(
    input.args,
    input.expectedScopes,
    now,
  );
  if (!artifacts.action) throw new Error("signed Gate 6 action is required");
  const pool = input.pool ?? await (input.createPool ?? createProductionGate6MysqlPool)({
    runtime: input.databaseRuntime ?? "host",
    expectedTargetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
  });
  const ledger = input.ledger ?? createGate6MysqlLedger(pool);
  let context;
  try {
    const binding = await ledger.getActionBinding(
      artifacts.envelope.gate6Id,
      artifacts.action.scope,
      artifacts.action.actionId,
    );
    const controllerAction = {
      ...artifacts.action,
      approvalSha256: artifacts.approvalSha256,
      releaseEnvironment: artifacts.envelope.releaseEnvironment,
      runtimeEnvironment: artifacts.envelope.runtimeEnvironment,
      drillMode: artifacts.envelope.drillMode,
      composeProject: artifacts.envelope.composeProject,
      envFile: artifacts.envelope.envFile,
      composeFiles: artifacts.envelope.composeFiles,
      envelopeSha256: createHash("sha256").update(canonicalGate6Json(artifacts.envelope)).digest("hex"),
      envelopeCoreSha256: artifacts.envelope.envelopeCoreSha256,
      expectedStage: binding.expectedStage,
      expectedCheckerSha256: binding.expectedCheckerSha256,
      minimumCompensationValidityMs:
        (artifacts.envelope.rtoMinutes + (input.worstCaseRollbackMinutes ?? 30)) * 60_000,
    };
    context = await authorizeGate6ForwardMutation({ ledger, action: controllerAction, now });
    const result = await input.execute({
      context,
      artifacts,
      ledger,
      pool,
      args: input.args,
      now,
    });
    const evidenceSha256 = createHash("sha256").update(canonicalGate6Json(result)).digest("hex");
    await completeGate6MutationContext(context, ledger, {
      status: "succeeded",
      afterEvidenceSha256: evidenceSha256,
      now: new Date(),
    });
    return { ok: true, gate6Id: artifacts.envelope.gate6Id, actionId: artifacts.action.actionId, evidenceSha256 };
  } catch (error) {
    if (context) {
      try {
        await completeGate6MutationContext(context, ledger, {
          status: "ambiguous",
          afterEvidenceSha256: createHash("sha256").update("controller-failure").digest("hex"),
          now: new Date(),
        });
      } catch {
        // The supervisor reconciles any consumed action whose completion write also failed.
      }
    }
    throw error;
  } finally {
    if (!input.pool && typeof pool?.end === "function") await pool.end();
  }
}

export async function runVerifiedGate6CompensationController(input) {
  const now = input.now ?? new Date();
  const artifacts = input.artifacts ?? await (input.loadArtifacts ?? loadVerifiedGate6ControllerArtifacts)(
    input.args,
    input.expectedScopes,
    now,
  );
  if (
    !artifacts.action
    || artifacts.action.kind !== "compensation"
    || typeof artifacts.action.pairedActionId !== "string"
    || artifacts.action.pairedActionId.length === 0
  ) throw new Error("signed Gate 6 compensation action is required");
  const pool = input.pool ?? await (input.createPool ?? createProductionGate6MysqlPool)({
    runtime: input.databaseRuntime ?? "host",
    expectedTargetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
  });
  const ledger = input.ledger ?? createGate6MysqlLedger(pool);
  let receipt;
  try {
    receipt = await ledger.beginCompensation({
      gate6Id: artifacts.envelope.gate6Id,
      scope: artifacts.action.scope,
      actionId: artifacts.action.actionId,
      pairedActionId: artifacts.action.pairedActionId,
      approvalSha256: artifacts.approvalSha256,
      allowedMutationSha256: artifacts.action.allowedMutationSha256,
      envelopeSha256: createHash("sha256").update(canonicalGate6Json(artifacts.envelope)).digest("hex"),
      envelopeCoreSha256: artifacts.envelope.envelopeCoreSha256,
      now,
    });
    const result = await input.execute({
      receipt,
      artifacts,
      ledger,
      pool,
      args: input.args,
      now,
    });
    const evidenceSha256 = createHash("sha256").update(canonicalGate6Json(result)).digest("hex");
    await ledger.finishAction(receipt, {
      status: "succeeded",
      afterEvidenceSha256: evidenceSha256,
      now: new Date(),
    });
    return { ok: true, gate6Id: artifacts.envelope.gate6Id, actionId: artifacts.action.actionId, evidenceSha256 };
  } catch (error) {
    if (receipt) {
      try {
        await ledger.finishAction(receipt, {
          status: "ambiguous",
          afterEvidenceSha256: createHash("sha256").update("compensation-controller-failure").digest("hex"),
          now: new Date(),
        });
      } catch {
        // The rollback supervisor retains the host/DB locks for manual reconciliation.
      }
    }
    throw error;
  } finally {
    if (!input.pool && typeof pool?.end === "function") await pool.end();
  }
}

export async function runVerifiedGate6AtomicController(input) {
  const now = input.now ?? new Date();
  const artifacts = input.artifacts ?? await (input.loadArtifacts ?? loadVerifiedGate6ControllerArtifacts)(
    input.args,
    input.expectedScopes,
    now,
  );
  if (!artifacts.action) throw new Error("signed Gate 6 action is required");
  const pool = input.pool ?? await (input.createPool ?? createProductionGate6MysqlPool)({
    runtime: input.databaseRuntime ?? "host",
    expectedTargetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
  });
  const ledger = input.ledger ?? createGate6MysqlLedger(pool);
  try {
    return await input.execute({ artifacts, ledger, pool, args: input.args, now });
  } finally {
    if (!input.pool && typeof pool?.end === "function") await pool.end();
  }
}
