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

export const PRODUCTION_WORKER_HANDOFFS = Object.freeze({
  ifn: Object.freeze({
    priorService: "worker-ifn-split",
    priorNodeId: "prod-worker-ifn-split-1",
    replacementService: "auto-accept-ifn-phase3",
    replacementNodeId: "prod-auto-accept-ifn-phase3-1",
  }),
  ptwl: Object.freeze({
    priorService: "worker-ptwl-split",
    priorNodeId: "prod-worker-ptwl-split-1",
    replacementService: "auto-accept-ptwl-phase3",
    replacementNodeId: "prod-auto-accept-ptwl-phase3-1",
  }),
});

function handoff(partition) {
  const value = PRODUCTION_WORKER_HANDOFFS[partition];
  if (!value) throw new Error("unknown production worker partition");
  return value;
}

function consume(context, consumeContext, scope) {
  const identity = consumeContext(context, scope);
  if (identity?.scope !== scope) throw new Error("worker Gate 6 action scope mismatch");
}

export async function forwardProductionWorkerCanary({ partition, context, consumeContext, adapter }) {
  const fixed = handoff(partition);
  consume(context, consumeContext, `worker-${partition}-forward`);
  const state = await adapter.inspect(fixed);
  if (state === "replacement-sole-owner") return { status: "succeeded", idempotent: true };
  if (state !== "prior-active") throw new Error("production worker ownership is indeterminate");
  let priorStopped = false;
  let replacementStarted = false;
  try {
    await adapter.stopPrior(fixed);
    priorStopped = true;
    if (await adapter.waitLeaseReleased(fixed) !== true) throw new Error("prior worker lease was not released");
    await adapter.startReplacement(fixed);
    replacementStarted = true;
    if (await adapter.verifySoleOwner(fixed) !== true) throw new Error("replacement worker is not the sole owner");
    return { status: "succeeded", idempotent: false };
  } catch (error) {
    if (replacementStarted) await adapter.stopReplacement(fixed);
    if (priorStopped) await adapter.restorePrior(fixed);
    throw error;
  }
}

export async function reverseProductionWorkerCanary({ partition, context, consumeContext, adapter }) {
  const fixed = handoff(partition);
  consume(context, consumeContext, `worker-${partition}-reverse`);
  const state = await adapter.inspect(fixed);
  if (state === "prior-active") return { status: "restored", idempotent: true };
  if (state !== "replacement-sole-owner") throw new Error("production worker ownership is indeterminate");
  await adapter.stopReplacement(fixed);
  await adapter.restorePrior(fixed);
  if (await adapter.verifyPriorSoleOwner(fixed) !== true) throw new Error("prior worker restore postcondition failed");
  return { status: "restored", idempotent: false };
}

export async function restoreProductionWorkerCompensation({ partition, adapter }) {
  const fixed = handoff(partition);
  const state = await adapter.inspect(fixed);
  if (state === "prior-active") return { status: "restored", idempotent: true };
  await adapter.stopReplacement(fixed);
  await adapter.restorePrior(fixed);
  if (await adapter.verifyPriorSoleOwner(fixed) !== true) {
    throw new Error("prior worker compensation postcondition failed");
  }
  return { status: "restored", idempotent: false };
}

function child(file, args) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        process.kill();
        return;
      }
      target.push(chunk);
    };
    process.stdout.on("data", collect(stdout));
    process.stderr.on("data", collect(stderr));
    process.once("error", reject);
    process.once("close", (code) => {
      if (bytes > 256 * 1024 || code !== 0) return reject(new Error("fixed worker command failed"));
      resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

function team(fixed) {
  return fixed.priorService.includes("ifn") ? 2 : 1;
}

function productionAdapter(composePrefix) {
  async function serviceRunning(service) {
    const output = await child("/usr/bin/docker", [
      ...composePrefix, "ps", "--status", "running", "--services", service,
    ]);
    return output.split(/\r?\n/).filter(Boolean).includes(service);
  }
  async function leaseEvidence(fixed) {
    const output = await child("/usr/bin/docker", [
      ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "node",
      fixed.priorService, "scripts/gate6-runtime-state-probe.mjs",
      "--probe=lease", `--team-id=${team(fixed)}`,
    ]);
    const value = JSON.parse(output);
    const keys = Object.keys(value).sort().join("\0");
    if (
      keys !== ["leaseActive", "ok", "ownerNodeId", "ownerRole", "probe", "status", "teamId"].sort().join("\0")
      || value.ok !== true
      || value.probe !== "lease"
      || value.teamId !== team(fixed)
      || (value.ownerNodeId !== null && typeof value.ownerNodeId !== "string")
      || typeof value.leaseActive !== "boolean"
    ) throw new Error("worker lease probe output is invalid");
    return value;
  }
  function expectedTeam(fixed) {
    return fixed.priorService.includes("ifn") ? 2 : 1;
  }
  return {
    async inspect(fixed) {
      const [prior, replacement] = await Promise.all([
        serviceRunning(fixed.priorService),
        serviceRunning(fixed.replacementService),
      ]);
      if (prior && !replacement) return "prior-active";
      if (!prior && replacement) return "replacement-sole-owner";
      return "indeterminate";
    },
    async stopPrior(fixed) {
      await child("/usr/bin/docker", [...composePrefix, "stop", "--timeout", "120", fixed.priorService]);
    },
    async waitLeaseReleased(fixed) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const lease = await leaseEvidence(fixed);
        if (!lease.leaseActive || lease.ownerNodeId !== fixed.priorNodeId) return true;
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      }
      return false;
    },
    async startReplacement(fixed) {
      await child("/usr/bin/docker", [...composePrefix, "--profile", "phase3", "up", "--detach", "--no-deps", fixed.replacementService]);
    },
    async verifySoleOwner(fixed) {
      const lease = await leaseEvidence(fixed);
      return await serviceRunning(fixed.replacementService)
        && !await serviceRunning(fixed.priorService)
        && lease.teamId === expectedTeam(fixed)
        && lease.leaseActive === true
        && lease.ownerNodeId === fixed.replacementNodeId;
    },
    async stopReplacement(fixed) {
      await child("/usr/bin/docker", [...composePrefix, "stop", "--timeout", "120", fixed.replacementService]);
    },
    async restorePrior(fixed) {
      await child("/usr/bin/docker", [...composePrefix, "up", "--detach", "--no-deps", fixed.priorService]);
    },
    async verifyPriorSoleOwner(fixed) {
      const lease = await leaseEvidence(fixed);
      return await serviceRunning(fixed.priorService)
        && !await serviceRunning(fixed.replacementService)
        && lease.teamId === expectedTeam(fixed)
        && lease.leaseActive === true
        && lease.ownerNodeId === fixed.priorNodeId;
    },
  };
}

async function main() {
  try {
    const args = parseGate6ControllerArgs(process.argv.slice(2), {
      actions: ["status", "forward", "reverse", "restore-prior"],
      readOnlyActions: ["status"],
    });
    let result;
    if (args.action === "status") {
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: ({ artifacts, ledger }) => ledger.getSanitizedSnapshot(artifacts.envelope.gate6Id),
      });
    } else if (args.action === "restore-prior") {
      result = await runVerifiedGate6CompensationController({
        args,
        expectedScopes: ["worker-ifn-restore-prior", "worker-ptwl-restore-prior"],
        execute: async ({ artifacts }) => {
          const match = /^worker-(ifn|ptwl)-restore-prior$/.exec(artifacts.action.scope);
          if (!match) throw new Error("worker compensation scope mismatch");
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return restoreProductionWorkerCompensation({
            partition: match[1],
            adapter: productionAdapter(candidateGate6ComposePrefix(release)),
          });
        },
      });
    } else {
      result = await runVerifiedGate6ControllerMutation({
        args,
        expectedScopes: [
          "worker-ifn-forward", "worker-ifn-reverse",
          "worker-ptwl-forward", "worker-ptwl-reverse",
        ],
        execute: async ({ context, artifacts }) => {
          const match = /^worker-(ifn|ptwl)-(forward|reverse)$/.exec(artifacts.action.scope);
          if (!match || match[2] !== args.action) throw new Error("worker action/scope mismatch");
          const operation = match[2] === "forward" ? forwardProductionWorkerCanary : reverseProductionWorkerCanary;
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return operation({
            partition: match[1],
            context,
            consumeContext: consumeGate6MutationContext,
            adapter: productionAdapter(candidateGate6ComposePrefix(release)),
          });
        },
      });
    }
    process.stdout.write(`${canonicalGate6Json({ ok: true, result })}\n`);
  } catch {
    process.stdout.write('{"code":"production-worker-control-refused","ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
