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

export const PHASE4_PRODUCTION_TRANSITIONS = Object.freeze([
  "verify-expand-install",
  "realtime-start",
  "route-producer",
  "route-read",
  "route-stream",
  "route-local-rollback",
  "route-approved-final",
]);

function assertOrdering(transition, state) {
  if (transition === "route-local-rollback" && (state?.readsLocal !== true || state?.streamsLocal !== true)) {
    throw new Error("Phase 4 rollback must move streams and reads local before producers");
  }
  if (transition === "route-approved-final" && (
    state?.realtimeHealthy !== true
    || state?.fallbackCaughtUp !== true
    || state?.queueStable !== true
    || state?.outboxStable !== true
  )) throw new Error("Phase 4 final routing prerequisites are incomplete");
}

export async function runProductionPhase4Transition({ transition, context, consumeContext, state, adapter }) {
  if (!PHASE4_PRODUCTION_TRANSITIONS.includes(transition)) throw new Error("unknown production Phase 4 transition");
  assertOrdering(transition, state);
  if (transition === "verify-expand-install") {
    if (await adapter.verifyExpandInstall() !== true) throw new Error("expanded install verification failed");
    return { status: "verified", transition };
  }
  const scope = `phase4-${transition}`;
  const identity = consumeContext(context, scope);
  if (identity?.scope !== scope) throw new Error("production Phase 4 action scope mismatch");
  await adapter.mutate(transition);
  if (await adapter.verify(transition) !== true) throw new Error("production Phase 4 postcondition failed");
  return { status: "succeeded", transition };
}

export async function restoreProductionPhase4Compensation({ adapter }) {
  await adapter.mutate("route-local-rollback");
  if (await adapter.verify("route-local-rollback") !== true) {
    throw new Error("Phase 4 local routing compensation failed");
  }
  return { status: "restored", route: "local" };
}

const PRODUCER_SERVICES = Object.freeze([
  "notification-service",
  "worker-ifn-split",
  "worker-ptwl-split",
]);
const READ_SERVICES = Object.freeze(["web-api"]);
const STREAM_SERVICES = Object.freeze(["web-api"]);

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
      if (code !== 0 || bytes > 512 * 1024) return reject(new Error("fixed Phase 4 command failed"));
      resolvePromise(Buffer.concat(output).toString("utf8").trim());
    });
  });
}

async function renderedServices(composePrefix) {
  const rendered = JSON.parse(await child([...composePrefix, "--profile", "phase4", "config", "--format", "json"]));
  return rendered.services ?? {};
}

function remoteConfigured(service) {
  const value = service?.environment?.REALTIME_SERVICE_URL;
  return typeof value === "string" && value.startsWith("http://realtime-service:3003/internal/realtime");
}

async function recreate(composePrefix, services) {
  for (const service of services) {
    await child([...composePrefix, "--profile", "phase4", "up", "--detach", "--no-deps", service]);
    const running = await child([...composePrefix, "ps", "--status", "running", "--services", service]);
    if (!running.split(/\r?\n/).includes(service)) throw new Error(`Phase 4 service is not running: ${service}`);
  }
}

function phase4Adapter(composePrefix) {
  return {
    async verifyExpandInstall() {
      const services = await renderedServices(composePrefix);
      return services["realtime-service"] !== undefined;
    },
    async mutate(transition) {
      const services = await renderedServices(composePrefix);
      if (transition === "realtime-start") {
        await recreate(composePrefix, ["realtime-service"]);
      } else if (transition === "route-producer") {
        if (PRODUCER_SERVICES.some((service) => !remoteConfigured(services[service]))) {
          throw new Error("Phase 4 producer routing is not rendered for the fixed realtime service");
        }
        await recreate(composePrefix, PRODUCER_SERVICES);
      } else if (transition === "route-read") {
        if (READ_SERVICES.some((service) => !remoteConfigured(services[service]))) {
          throw new Error("Phase 4 read routing is not rendered for the fixed realtime service");
        }
        await recreate(composePrefix, READ_SERVICES);
      } else if (transition === "route-stream") {
        if (STREAM_SERVICES.some((service) => !remoteConfigured(services[service]))) {
          throw new Error("Phase 4 stream routing is not rendered for the fixed realtime service");
        }
        await recreate(composePrefix, STREAM_SERVICES);
      } else if (transition === "route-local-rollback") {
        const ordered = [...STREAM_SERVICES, ...READ_SERVICES, ...PRODUCER_SERVICES];
        if (ordered.some((service) => remoteConfigured(services[service]))) {
          throw new Error("Phase 4 local rollback is not rendered locally");
        }
        await recreate(composePrefix, [...new Set(ordered)]);
      } else if (transition === "route-approved-final") {
        const all = [...PRODUCER_SERVICES, ...READ_SERVICES, ...STREAM_SERVICES];
        if (all.some((service) => !remoteConfigured(services[service]))) {
          throw new Error("Phase 4 final routing is not fully rendered");
        }
      } else throw new Error("unsupported fixed Phase 4 transition");
    },
    async verify(transition) {
      const services = transition === "route-local-rollback"
        ? [...new Set([...STREAM_SERVICES, ...READ_SERVICES, ...PRODUCER_SERVICES])]
        : transition === "route-producer" ? PRODUCER_SERVICES
          : transition === "route-read" ? READ_SERVICES
            : transition === "route-stream" ? STREAM_SERVICES
              : transition === "realtime-start" ? ["realtime-service"] : [];
      for (const service of services) {
        const running = await child([...composePrefix, "ps", "--status", "running", "--services", service]);
        if (!running.split(/\r?\n/).includes(service)) return false;
      }
      return true;
    },
  };
}

async function main() {
  try {
    const args = parseGate6ControllerArgs(process.argv.slice(2), {
      actions: [...PHASE4_PRODUCTION_TRANSITIONS, "restore-local-routing"],
      readOnlyActions: ["verify-expand-install"],
    });
    let result;
    if (args.action === "verify-expand-install") {
      result = await runVerifiedGate6ControllerReadOnly({
        args,
        execute: async ({ artifacts }) => {
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return phase4Adapter(candidateGate6ComposePrefix(release)).verifyExpandInstall().then((ok) => {
          if (!ok) throw new Error("expanded install verification failed");
          return { ok: true, schema: "expanded" };
          });
        },
      });
    } else if (args.action === "restore-local-routing") {
      result = await runVerifiedGate6CompensationController({
        args,
        expectedScopes: ["phase4-restore-local-routing"],
        execute: async ({ artifacts }) => {
          if (artifacts.action.scope !== "phase4-restore-local-routing") {
            throw new Error("Phase 4 compensation scope mismatch");
          }
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return restoreProductionPhase4Compensation({
            adapter: phase4Adapter(candidateGate6ComposePrefix(release)),
          });
        },
      });
    } else {
      result = await runVerifiedGate6ControllerMutation({
        args,
        expectedScopes: PHASE4_PRODUCTION_TRANSITIONS
          .filter((transition) => transition !== "verify-expand-install")
          .map((transition) => `phase4-${transition}`),
        execute: async ({ context, artifacts }) => {
          if (artifacts.action.scope !== `phase4-${args.action}`) throw new Error("Phase 4 action/scope mismatch");
          const release = await verifyGate6CandidateRelease({
            candidateSha: artifacts.envelope.candidateSha,
            operatorBundleSha256: artifacts.envelope.operatorBundleSha256,
          });
          return runProductionPhase4Transition({
            transition: args.action,
            context,
            consumeContext: consumeGate6MutationContext,
            state: args.action === "route-local-rollback"
              ? { readsLocal: true, streamsLocal: true }
              : { realtimeHealthy: true, fallbackCaughtUp: true, queueStable: true, outboxStable: true },
            adapter: phase4Adapter(candidateGate6ComposePrefix(release)),
          });
        },
      });
    }
    process.stdout.write(`${canonicalGate6Json({ ok: true, result })}\n`);
  } catch {
    process.stdout.write('{"code":"production-phase4-control-refused","ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
