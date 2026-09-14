#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { consumeGate6MutationContext } from "./lib/gate6-controller.mjs";
import {
  parseGate6ControllerArgs,
  runVerifiedGate6CompensationController,
  runVerifiedGate6ControllerMutation,
  runVerifiedGate6ControllerReadOnly,
} from "./lib/gate6-cli-runtime.mjs";
import { createProductionDbCredentialAdapter } from "./lib/production-db-principal-files.mjs";
import { readEvidenceBytes } from "./lib/evidence-artifact.mjs";
import { verifyGate6PostProofBundle } from "./lib/gate6-postproof-actions.mjs";
import {
  candidateGate6ComposePrefix,
  verifyGate6CandidateRelease,
} from "./lib/gate6-immutable-runtime.mjs";

import {
  DB_PRINCIPAL_BOOTSTRAP_ROLES,
  PRODUCTION_DB_ROLE_ORDER,
  PRODUCTION_DB_ROLE_SCOPE,
  assertKnownProductionDbRole,
  productionAccountHost,
} from "./db-principal-rollout.mjs";

export { PRODUCTION_DB_ROLE_ORDER };

const ACTIVE_COMPOSE_SERVICES = new Set([
  "realtime-service",
  "line-service",
  "notification-service",
  "worker-ifn-split",
  "worker-ptwl-split",
  "web-api",
]);
const POSTPROOF_BUNDLE_FILE = "/var/lib/spx-gate6/postproof/postproof-actions.json";
const POSTPROOF_EXECUTOR_SERVICE = "gate6-postproof-db-executor";

export async function verifyProductionDbPrincipalBootstrap({ descriptor, verifier }) {
  const evidence = [];
  for (const role of [...DB_PRINCIPAL_BOOTSTRAP_ROLES, ...PRODUCTION_DB_ROLE_ORDER]) {
    const host = productionAccountHost(descriptor, role);
    const result = await verifier(role, host);
    if (
      result?.role !== role
      || result?.host !== host
      || result?.positive !== true
      || result?.forbidden !== true
      || !/^[0-9a-f]{64}$/.test(result?.grantsSha256 ?? "")
    ) throw new Error(`DB principal bootstrap proof failed for ${role}`);
    evidence.push(Object.freeze({
      role,
      accountHost: host,
      grantsSha256: result.grantsSha256,
      positive: true,
      forbidden: true,
    }));
  }
  return evidence;
}

export async function switchProductionDbPrincipal({
  descriptor,
  role,
  mutationContext,
  consumeContext,
  adapter,
}) {
  assertKnownProductionDbRole(role);
  if (!PRODUCTION_DB_ROLE_ORDER.includes(role)) throw new Error("DB role is not switchable");
  const accountHost = productionAccountHost(descriptor, role);
  const scopeSuffix = PRODUCTION_DB_ROLE_SCOPE[role];
  const expectedScope = `db-principal-switch-${scopeSuffix}`;
  const identity = consumeContext(mutationContext, expectedScope);
  if (identity?.scope !== expectedScope) throw new Error("DB principal action scope mismatch");
  if (!adapter || typeof adapter.captureBaseline !== "function" || typeof adapter.stageCredential !== "function") {
    throw new Error("DB principal transition adapter is incomplete");
  }
  const baseline = await adapter.captureBaseline({ role });
  let credentialStaged = false;
  try {
    await adapter.stageCredential({ role, accountHost });
    credentialStaged = true;
    if (baseline?.active === true) {
      if (!ACTIVE_COMPOSE_SERVICES.has(role) || typeof adapter.recreateExactService !== "function") {
        throw new Error("DB role cannot activate a caller-selected service");
      }
      await adapter.recreateExactService({ role });
    }
    if (typeof adapter.verifyPostconditions !== "function" || await adapter.verifyPostconditions({
      role,
      accountHost,
      serviceExpectedActive: baseline?.active === true,
    }) !== true) throw new Error("DB principal postcondition failed");
    return { status: baseline?.active === true ? "switched" : "staged", role, accountHost };
  } catch (error) {
    if (credentialStaged) {
      await adapter.restoreCredential({ role });
      if (baseline?.active === true) await adapter.restoreExactService({ role, baseline });
    }
    throw error;
  }
}

export async function prepareProductionDbPrincipal({
  descriptor,
  role,
  mutationContext,
  consumeContext,
  adapter,
}) {
  assertKnownProductionDbRole(role);
  if (!PRODUCTION_DB_ROLE_ORDER.includes(role)) throw new Error("DB role is not preparable");
  const accountHost = productionAccountHost(descriptor, role);
  const expectedScope = role === "migrator"
    ? "db-principal-verify-migrator"
    : `db-principal-prepare-${PRODUCTION_DB_ROLE_SCOPE[role]}`;
  const identity = consumeContext(mutationContext, expectedScope);
  if (identity?.scope !== expectedScope) throw new Error("DB principal prepare action scope mismatch");
  if (role === "migrator") {
    if (await adapter.verifyExisting({ role, accountHost }) !== true) {
      throw new Error("migrator principal verification failed");
    }
    return { status: "verified", role, accountHost };
  }
  await adapter.prepareRestricted({ role, accountHost });
  if (await adapter.verifyPrepared({ role, accountHost }) !== true) {
    throw new Error("DB principal preparation postcondition failed");
  }
  return { status: "prepared", role, accountHost };
}

export async function revokeLegacyPrincipal({
  revokeContext,
  consumeContext,
  adapter,
  priorGrantsSha256,
}) {
  if (!/^[0-9a-f]{64}$/.test(priorGrantsSha256)) throw new Error("prior grant hash is invalid");
  const revoke = consumeContext(revokeContext, "db-principal-revoke-legacy");
  if (revoke?.scope !== "db-principal-revoke-legacy") throw new Error("legacy revoke action scope mismatch");
  try {
    await adapter.revokeExactLegacyGrants({ priorGrantsSha256 });
    if (await adapter.verifyLegacyRevoked() !== true) throw new Error("legacy revoke postcondition failed");
    return { status: "revoked" };
  } catch (error) {
    await adapter.restoreExactLegacyGrants({ priorGrantsSha256 });
    if (await adapter.verifyLegacyRestored() !== true) throw new Error("legacy grant restoration failed");
    throw error;
  }
}

export async function executePostProofLegacyGrantAction(input) {
  const verified = (input.verifyBundle ?? verifyGate6PostProofBundle)({
    bundle: input.bundle,
    envelope: input.artifacts.envelope,
    keyring: input.artifacts.keyring,
    now: input.now,
  });
  if (!verified?.ok) throw new Error("post-proof legacy grant bundle is invalid");
  const restore = input.actionName === "restore-legacy";
  if (!restore && input.actionName !== "revoke-legacy") {
    throw new Error("post-proof legacy grant action is invalid");
  }
  const action = restore ? verified.restore : verified.revoke;
  const now = input.now ?? new Date();
  const envelopeSha256 = createHash("sha256")
    .update(canonicalGate6Json(input.artifacts.envelope))
    .digest("hex");
  let receipt;
  try {
    receipt = restore
      ? await input.ledger.beginCompensation({
        gate6Id: input.artifacts.envelope.gate6Id,
        scope: action.scope,
        actionId: action.actionId,
        pairedActionId: action.pairedActionId,
        approvalSha256: action.approvalSha256,
        allowedMutationSha256: action.allowedMutationSha256,
        envelopeSha256,
        envelopeCoreSha256: input.artifacts.envelope.envelopeCoreSha256,
        now,
      })
      : await input.ledger.beginAction({
        gate6Id: input.artifacts.envelope.gate6Id,
        scope: action.scope,
        actionId: action.actionId,
        approvalSha256: action.approvalSha256,
        allowedMutationSha256: action.allowedMutationSha256,
        envelopeSha256,
        envelopeCoreSha256: input.artifacts.envelope.envelopeCoreSha256,
        expectedStage: action.requiredStage,
        expectedCheckerSha256: action.requiredCheckerSha256,
        minimumCompensationValidityMs: (input.artifacts.envelope.rtoMinutes + 30) * 60_000,
        now,
      });
    const result = await input.grantAdapter.converge(restore ? "restore" : "revoke", verified);
    const evidenceSha256 = createHash("sha256").update(canonicalGate6Json(result)).digest("hex");
    await input.ledger.finishAction(receipt, {
      status: "succeeded",
      afterEvidenceSha256: evidenceSha256,
      now: new Date(),
    });
    return { status: result.status, evidenceSha256 };
  } catch (error) {
    if (receipt) {
      if (!restore) {
        try {
          await input.grantAdapter.converge("restore", verified);
        } catch {
          // Durable compensation remains registered for the rollback supervisor.
        }
      }
      try {
        await input.ledger.finishAction(receipt, {
          status: "ambiguous",
          afterEvidenceSha256: createHash("sha256").update("postproof-grant-failure").digest("hex"),
          now: new Date(),
        });
      } catch {
        // Stale consumed-action reconciliation revokes the run if completion also fails.
      }
    }
    throw error;
  }
}

function dockerCommand(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/docker", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || bytes > 256 * 1024) {
        rejectPromise(new Error("fixed DB principal Docker command failed"));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

function productionDockerAdapter(composePrefix) {
  return Object.freeze({
    async isRunning(service) {
      if (!ACTIVE_COMPOSE_SERVICES.has(service)) return false;
      const output = await dockerCommand([...composePrefix, "ps", "--status", "running", "--services", service]);
      return output.split(/\r?\n/).filter(Boolean).includes(service);
    },
    async recreate(service) {
      if (!ACTIVE_COMPOSE_SERVICES.has(service)) throw new Error("unknown DB principal service target");
      await dockerCommand([...composePrefix, "up", "--detach", "--no-deps", "--force-recreate", service]);
    },
    async isReady(service) {
      if (!ACTIVE_COMPOSE_SERVICES.has(service)) return false;
      const output = await dockerCommand([...composePrefix, "ps", "--status", "running", "--services", service]);
      return output.split(/\r?\n/).filter(Boolean).includes(service);
    },
  });
}

function postProofGrantDockerAdapter(composePrefix, envelope) {
  return Object.freeze({
    async converge(action, verified) {
      const text = await dockerCommand([
        ...composePrefix,
        "--profile", "gate6", "run", "--rm", "--no-deps",
        POSTPROOF_EXECUTOR_SERVICE,
        "node", "scripts/gate6-legacy-grant-executor.mjs",
        `--action=${action}`,
        `--prior-grants-sha256=${verified.priorGrantsSha256}`,
        `--target-descriptor-sha256=${envelope.productionTargetDescriptorSha256}`,
        `--positive-grant-proof-sha256=${verified.positiveGrantProofSha256}`,
        `--forbidden-grant-proof-sha256=${verified.forbiddenGrantProofSha256}`,
        `--backup-evidence-sha256=${verified.backupEvidenceSha256}`,
      ]);
      const value = JSON.parse(text);
      if (
        canonicalGate6Json(value) !== text
        || value?.ok !== true
        || !["revoked", "granted"].includes(value.status)
        || typeof value.idempotent !== "boolean"
      ) throw new Error("post-proof legacy grant executor output is invalid");
      return value;
    },
  });
}

async function readPostProofBundle(path) {
  if (resolve(path) !== resolve(POSTPROOF_BUNDLE_FILE)) {
    throw new Error("post-proof legacy grant bundle path is invalid");
  }
  const bytes = await readEvidenceBytes(path, { maxFileBytes: 512 * 1024 });
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (text !== canonicalGate6Json(value)) throw new Error("post-proof legacy grant bundle is not canonical");
  return value;
}

function roleScope(role, operation) {
  assertKnownProductionDbRole(role);
  const suffix = PRODUCTION_DB_ROLE_SCOPE[role];
  if (operation === "prepare") return role === "migrator"
    ? "db-principal-verify-migrator"
    : `db-principal-prepare-${suffix}`;
  if (operation === "switch-service") return `db-principal-switch-${suffix}`;
  return `db-principal-restore-${suffix}`;
}

async function main() {
  try {
    const args = parseGate6ControllerArgs(process.argv.slice(2), {
      actions: ["status", "prepare", "switch-service", "restore-role", "revoke-legacy", "restore-legacy"],
      readOnlyActions: ["status", "revoke-legacy", "restore-legacy"],
      extraArguments: ["role", "service", "postproof-bundle"],
    });
    let result;
    if (args.action === "status") {
      if (args.role || args.service) throw new Error("DB principal status accepts no role");
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: ({ artifacts, ledger }) => ledger.getSanitizedSnapshot(artifacts.envelope.gate6Id),
      });
    } else if (["revoke-legacy", "restore-legacy"].includes(args.action)) {
      if (args.role || args.service || args["action-approval"] || !args["postproof-bundle"]) {
        throw new Error("post-proof legacy grant selector is invalid");
      }
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: async ({ artifacts, ledger, now }) => {
          const bundle = await readPostProofBundle(args["postproof-bundle"]);
          const verified = verifyGate6PostProofBundle({
            bundle,
            envelope: artifacts.envelope,
            keyring: artifacts.keyring,
            now,
          });
          if (!verified.ok) throw new Error("post-proof legacy grant bundle is invalid");
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return executePostProofLegacyGrantAction({
            actionName: args.action,
            artifacts,
            bundle,
            ledger,
            now,
            verifyBundle: () => verified,
            grantAdapter: postProofGrantDockerAdapter(
              candidateGate6ComposePrefix(release),
              artifacts.envelope,
            ),
          });
        },
      });
    } else {
      if (args["postproof-bundle"]) throw new Error("post-proof bundle is legacy-grant-only");
      const role = args.action === "switch-service" ? args.service : args.role;
      if (!PRODUCTION_DB_ROLE_ORDER.includes(role)) throw new Error("production DB role is required");
      if ((args.action === "switch-service" && args.role) || (args.action !== "switch-service" && args.service)) {
        throw new Error("production DB role selector is invalid");
      }
      const scope = roleScope(role, args.action);
      if (args.action === "restore-role") {
        result = await runVerifiedGate6CompensationController({
          args,
          expectedScopes: [scope],
          execute: async ({ artifacts }) => {
            if (artifacts.action.scope !== scope) throw new Error("DB principal compensation scope mismatch");
            const release = await verifyGate6CandidateRelease({
              candidateSha: artifacts.envelope.candidateSha,
              operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
            });
            const adapter = createProductionDbCredentialAdapter({
              targetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
              docker: productionDockerAdapter(candidateGate6ComposePrefix(release)),
            });
            if (await adapter.restoreRole(role) !== true) throw new Error("DB principal role restoration failed");
            return { status: "restored", role };
          },
        });
      } else {
        result = await runVerifiedGate6ControllerMutation({
          args,
          expectedScopes: [scope],
          execute: async ({ context, artifacts }) => {
            if (artifacts.action.scope !== scope) throw new Error("DB principal action scope mismatch");
            const release = await verifyGate6CandidateRelease({
              candidateSha: artifacts.envelope.candidateSha,
              operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
            });
            const adapter = createProductionDbCredentialAdapter({
              targetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
              docker: productionDockerAdapter(candidateGate6ComposePrefix(release)),
            });
            const descriptor = await adapter.descriptor();
            return args.action === "prepare"
              ? prepareProductionDbPrincipal({
                descriptor,
                role,
                mutationContext: context,
                consumeContext: consumeGate6MutationContext,
                adapter,
              })
              : switchProductionDbPrincipal({
                descriptor,
                role,
                mutationContext: context,
                consumeContext: consumeGate6MutationContext,
                adapter,
              });
          },
        });
      }
    }
    process.stdout.write(`${canonicalGate6Json({ ok: true, result })}\n`);
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "production-db-principal-control-refused" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
