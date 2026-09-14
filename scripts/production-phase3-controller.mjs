#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
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
import {
  candidateGate6ComposePrefix,
  verifyGate6CandidateRelease,
} from "./lib/gate6-immutable-runtime.mjs";
import { createProductionPhase3ControlMysqlPool } from "./lib/gate6-mysql-ledger.mjs";
import {
  createPhase3PublicationMysqlOperations,
  executeGate6Phase3PublicationMutation,
} from "./phase3-publication-control.mjs";

export const PHASE3_PRODUCTION_TRANSITIONS = Object.freeze([
  "consumer-start-disabled",
  "legacy-lease-release",
  "poller-start",
  "publication-enable",
  "execution-enable",
  "publication-fence",
  "fence-ack-wait",
  "drain-or-quarantine",
  "inline-owner-restore",
]);

export async function runProductionPhase3Transition({
  transition,
  teamId,
  epoch,
  nodeId,
  envelope,
  context,
  consumeContext,
  publicationControl,
  rollback,
}) {
  if (!PHASE3_PRODUCTION_TRANSITIONS.includes(transition)) throw new Error("unknown production Phase 3 transition");
  if (!Number.isSafeInteger(teamId) || teamId !== envelope?.canaryTeamId) {
    throw new Error("production Phase 3 team mismatch");
  }
  if (typeof epoch !== "string" || epoch !== envelope?.canaryEpoch) {
    throw new Error("production Phase 3 epoch mismatch");
  }
  if (
    typeof nodeId !== "string"
    || !Array.isArray(envelope?.productionPhase3NodeIds)
    || !envelope.productionPhase3NodeIds.includes(nodeId)
  ) throw new Error("production Phase 3 node mismatch");
  const scope = `phase3-${transition}`;
  try {
    const publicationTransition = transition === "publication-enable" || transition === "publication-fence";
    let evidence;
    if (publicationTransition) {
      if (typeof publicationControl?.executeGate6Phase3PublicationMutation !== "function") {
        throw new Error("Phase 3 publication controller is unavailable");
      }
      evidence = await publicationControl.executeGate6Phase3PublicationMutation({
        context,
        scope,
        binding: Object.freeze({ teamId, epoch, pollerNodeId: nodeId }),
      });
    } else {
      const identity = consumeContext(context, scope);
      if (identity?.scope !== scope) throw new Error("production Phase 3 action scope mismatch");
      if (typeof publicationControl?.execute !== "function") {
        throw new Error("Phase 3 transition controller is unavailable");
      }
      evidence = await publicationControl.execute({
        transition,
        signedIdentity: Object.freeze({ teamId, epoch, nodeId }),
      });
    }
    if (evidence?.ok !== true) throw new Error("Phase 3 transition postcondition failed");
    return { status: "succeeded", transition, evidence };
  } catch (error) {
    await rollback({ transition });
    throw error;
  }
}

export async function restoreProductionPhase3Compensation({ adapter }) {
  if (typeof adapter?.restoreInlineOwner !== "function" || typeof adapter?.verifyInlineOwner !== "function") {
    throw new Error("Phase 3 compensation adapter is unavailable");
  }
  await adapter.restoreInlineOwner();
  if (await adapter.verifyInlineOwner() !== true) throw new Error("Phase 3 inline owner compensation failed");
  return { status: "restored", owner: "inline" };
}

const PHASE3_PARTITIONS = Object.freeze({
  1: Object.freeze({
    teamId: 1,
    pollerService: "poller-ptwl-phase3",
    pollerNodeId: "prod-poller-ptwl-phase3-1",
    consumerService: "auto-accept-ptwl-phase3",
    legacyNodeId: "prod-worker-ptwl-split-1",
    legacyService: "worker-ptwl-split",
  }),
  2: Object.freeze({
    teamId: 2,
    pollerService: "poller-ifn-phase3",
    pollerNodeId: "prod-poller-ifn-phase3-1",
    consumerService: "auto-accept-ifn-phase3",
    legacyNodeId: "prod-worker-ifn-split-1",
    legacyService: "worker-ifn-split",
  }),
});
function child(args) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn("/usr/bin/docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const output = [];
    let bytes = 0;
    process.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) process.kill();
      else output.push(chunk);
    });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code !== 0 || bytes > 512 * 1024) return reject(new Error("fixed Phase 3 command failed"));
      resolvePromise(Buffer.concat(output).toString("utf8").trim());
    });
  });
}

async function serviceProbe(composePrefix, service, args) {
  const output = await child([
    ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "node",
    service, "scripts/gate6-runtime-state-probe.mjs", ...args,
  ]);
  const value = JSON.parse(output);
  if (value?.ok !== true || value.teamId === undefined) throw new Error("Phase 3 service probe failed");
  return value;
}

async function leaseProbe(composePrefix, partition) {
  const value = await serviceProbe(composePrefix, partition.consumerService, [
    "--probe=lease", `--team-id=${partition.teamId}`,
  ]);
  const keys = Object.keys(value).sort().join("\0");
  if (
    keys !== ["leaseActive", "ok", "ownerNodeId", "ownerRole", "probe", "status", "teamId"].sort().join("\0")
    || value.probe !== "lease"
    || value.teamId !== partition.teamId
  ) throw new Error("Phase 3 lease probe output is invalid");
  return value;
}

function phase3Operations(partition, composePrefix) {
  return {
    async restoreInlineOwner() {
      await child([...composePrefix, "stop", "--timeout", "120", partition.consumerService, partition.pollerService]);
      await child([...composePrefix, "up", "--detach", "--no-deps", partition.legacyService]);
    },
    async verifyInlineOwner() {
      const lease = await leaseProbe(composePrefix, partition);
      return lease.leaseActive === true && lease.ownerNodeId === partition.legacyNodeId;
    },
    async execute({ transition }) {
      if (transition === "consumer-start-disabled") {
        const rendered = JSON.parse(await child([...composePrefix, "--profile", "phase3", "config", "--format", "json"]));
        const environment = rendered.services?.[partition.consumerService]?.environment;
        if (String(environment?.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED) !== "false") {
          throw new Error("Phase 3 consumer is not rendered disabled");
        }
        await child([...composePrefix, "--profile", "phase3", "up", "--detach", "--no-deps", partition.consumerService]);
      } else if (transition === "legacy-lease-release") {
        const lease = await leaseProbe(composePrefix, partition);
        if (lease.leaseActive === true && lease.ownerNodeId === partition.legacyNodeId) {
          throw new Error("legacy Phase 3 lease remains active");
        }
      } else if (transition === "poller-start") {
        await child([...composePrefix, "--profile", "phase3", "up", "--detach", "--no-deps", partition.pollerService]);
      } else if (transition === "execution-enable") {
        await child([...composePrefix, "--profile", "phase3", "up", "--detach", "--no-deps", partition.consumerService]);
      } else if (transition === "fence-ack-wait") {
        throw new Error("fence acknowledgement is a read-only transition");
      } else if (transition === "drain-or-quarantine") {
        const evidence = await serviceProbe(composePrefix, partition.consumerService, [
          "--probe=phase3-drain", `--team-id=${partition.teamId}`,
        ]);
        const keys = Object.keys(evidence).sort().join("\0");
        if (
          keys !== ["activeCount", "ok", "probe", "teamId"].sort().join("\0")
          || evidence.probe !== "phase3-drain"
          || evidence.teamId !== partition.teamId
          || evidence.activeCount !== 0
        ) throw new Error("Phase 3 work is not drained or quarantined");
      } else if (transition === "inline-owner-restore") {
        const lease = await leaseProbe(composePrefix, partition);
        if (lease.leaseActive !== true || lease.ownerNodeId !== partition.legacyNodeId) {
          throw new Error("inline owner restoration is incomplete");
        }
      } else {
        throw new Error("unsupported fixed Phase 3 transition");
      }
      return { ok: true, transition };
    },
  };
}

async function readFenceAcknowledgement(envelope, partition, composePrefix) {
  const row = await serviceProbe(composePrefix, partition.pollerService, [
    "--probe=phase3-fence", `--team-id=${partition.teamId}`, `--epoch=${envelope.canaryEpoch}`,
  ]);
  const keys = Object.keys(row).sort().join("\0");
  if (
    keys !== [
      "ackJobId", "ackNodeId", "acknowledged", "active", "epoch", "fenceJobId",
      "ok", "pollerNodeId", "probe", "state", "teamId",
    ].sort().join("\0")
    || row.probe !== "phase3-fence"
    || row.teamId !== partition.teamId
    || row.epoch !== envelope.canaryEpoch
    || row.state !== "fenced"
    || row.pollerNodeId !== partition.pollerNodeId
    || row.ackNodeId !== partition.pollerNodeId
    || row.acknowledged !== true
    || row.active !== true
    || row.ackJobId < row.fenceJobId
  ) throw new Error("Phase 3 fence acknowledgement is incomplete");
  return { ok: true, state: "fenced", acknowledged: true };
}

async function main() {
  try {
    const args = parseGate6ControllerArgs(process.argv.slice(2), {
      actions: [...PHASE3_PRODUCTION_TRANSITIONS, "restore-inline-owner"],
      readOnlyActions: ["fence-ack-wait"],
    });
    let result;
    if (args.action === "fence-ack-wait") {
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: async ({ artifacts }) => {
          const partition = PHASE3_PARTITIONS[artifacts.envelope.canaryTeamId];
          if (!partition) throw new Error("unknown signed Phase 3 partition");
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return readFenceAcknowledgement(
            artifacts.envelope,
            partition,
            candidateGate6ComposePrefix(release),
          );
        },
      });
    } else if (args.action === "restore-inline-owner") {
      result = await runVerifiedGate6CompensationController({
        args,
        expectedScopes: ["phase3-restore-inline-owner"],
        execute: async ({ artifacts }) => {
          if (artifacts.action.scope !== "phase3-restore-inline-owner") {
            throw new Error("Phase 3 compensation scope mismatch");
          }
          const partition = PHASE3_PARTITIONS[artifacts.envelope.canaryTeamId];
          if (!partition) throw new Error("unknown signed Phase 3 partition");
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return restoreProductionPhase3Compensation({
            adapter: phase3Operations(partition, candidateGate6ComposePrefix(release)),
          });
        },
      });
    } else {
      result = await runVerifiedGate6ControllerMutation({
        args,
        expectedScopes: PHASE3_PRODUCTION_TRANSITIONS
          .filter((transition) => transition !== "fence-ack-wait")
          .map((transition) => `phase3-${transition}`),
        execute: async ({ context, artifacts }) => {
          const partition = PHASE3_PARTITIONS[artifacts.envelope.canaryTeamId];
          if (!partition) throw new Error("unknown signed Phase 3 partition");
          if (artifacts.action.scope !== `phase3-${args.action}`) throw new Error("Phase 3 action/scope mismatch");
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          const composePrefix = candidateGate6ComposePrefix(release);
          const publicationTransition = ["publication-enable", "publication-fence"].includes(args.action);
          const phase3Pool = publicationTransition
            ? await createProductionPhase3ControlMysqlPool({
              expectedTargetDescriptorSha256: artifacts.envelope.productionTargetDescriptorSha256,
            })
            : null;
          try {
            const operations = phase3Pool
              ? createPhase3PublicationMysqlOperations(() => phase3Pool.getConnection())
              : null;
            return await runProductionPhase3Transition({
              transition: args.action,
              teamId: artifacts.envelope.canaryTeamId,
              epoch: artifacts.envelope.canaryEpoch,
              nodeId: partition.pollerNodeId,
              envelope: {
                ...artifacts.envelope,
                productionPhase3NodeIds: [partition.pollerNodeId],
              },
              context,
              consumeContext: consumeGate6MutationContext,
              publicationControl: {
                executeGate6Phase3PublicationMutation: (input) =>
                  executeGate6Phase3PublicationMutation({ ...input, operations }),
                ...phase3Operations(partition, composePrefix),
              },
              rollback: async () => {},
            });
          } finally {
            if (phase3Pool) await phase3Pool.end();
          }
        },
      });
    }
    process.stdout.write(`${canonicalGate6Json({ ok: true, result })}\n`);
  } catch {
    process.stdout.write('{"code":"production-phase3-control-refused","ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
