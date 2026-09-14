#!/usr/bin/env node

import { readEvidenceJson, canonicalJson } from "./lib/evidence-artifact.mjs";

const PRODUCERS = Object.freeze(["poller", "notification", "line"]);
const OPERATIONS = Object.freeze([
  "producer",
  "read",
  "stream",
  "local-rollback",
  "approved-final",
  "final-cleanup-baseline",
]);
const STATE_PATH = "/var/lib/spx-staging-rollout/phase4-routing-state.json";

export const PHASE4_ROUTING_ACTION_IDS = Object.freeze({
  producer: "phase4-route-producer",
  read: "phase4-route-read",
  stream: "phase4-route-stream",
  localRollback: "phase4-route-local-rollback",
  approvedFinal: "phase4-route-approved-final",
  finalCleanupBaseline: "phase4-route-final-cleanup-baseline",
});

function finiteWatermark(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function actionIdFor(operation) {
  const key = {
    producer: "producer",
    read: "read",
    stream: "stream",
    "local-rollback": "localRollback",
    "approved-final": "approvedFinal",
    "final-cleanup-baseline": "finalCleanupBaseline",
  }[operation];
  return key ? PHASE4_ROUTING_ACTION_IDS[key] : null;
}

export function validateRoutingPlan(plan) {
  const failures = [];
  const producers = plan?.producers;
  if (plan?.environment !== "staging") failures.push("ROUTING_ENVIRONMENT_INVALID");
  if (plan?.composeProject !== "spx-staging") failures.push("ROUTING_PROJECT_INVALID");
  if (!/^[0-9a-f]{40}$/.test(plan?.releaseSha ?? "")) failures.push("ROUTING_RELEASE_INVALID");
  if (
    !Array.isArray(producers) ||
    new Set(producers).size !== producers.length ||
    producers.some((producer) => !PRODUCERS.includes(producer)) ||
    !same(producers, PRODUCERS.filter((producer) => producers.includes(producer)))
  ) {
    failures.push("ROUTING_PRODUCER_SET_INVALID");
  }
  if (typeof plan?.webReadsRemote !== "boolean" || typeof plan?.webStreamsRemote !== "boolean") {
    failures.push("ROUTING_WEB_FLAGS_INVALID");
  } else {
    if (plan.webStreamsRemote && !plan.webReadsRemote) failures.push("ROUTING_STREAM_REQUIRES_READS");
    if (plan.webReadsRemote && !same(producers, PRODUCERS)) {
      failures.push("ROUTING_WEB_REQUIRES_ALL_PRODUCERS");
    }
  }
  if (!finiteWatermark(plan?.routingWatermark)) failures.push("ROUTING_WATERMARK_INVALID");
  return { ok: failures.length === 0, failures };
}

function isLocal(plan) {
  return plan.producers.length === 0 && !plan.webReadsRemote && !plan.webStreamsRemote;
}

function allProducers(plan) {
  return same(plan.producers, PRODUCERS);
}

function commonTransitionFailures(previous, next) {
  const failures = [];
  if (!validateRoutingPlan(previous).ok || !validateRoutingPlan(next).ok) {
    failures.push("ROUTING_PLAN_INVALID");
    return failures;
  }
  if (
    previous.environment !== next.environment ||
    previous.composeProject !== next.composeProject ||
    previous.releaseSha !== next.releaseSha
  ) {
    failures.push("ROUTING_RELEASE_BINDING_CHANGED");
  }
  if (next.singletonOwners !== undefined && next.singletonOwners !== 1) {
    failures.push("REALTIME_SINGLETON_VIOLATION");
  }
  if (next.routingWatermark < previous.routingWatermark) {
    failures.push("ROUTING_WATERMARK_REGRESSED");
  }
  return failures;
}

export function validateRoutingTransition(previous, next, operation) {
  if (!OPERATIONS.includes(operation)) {
    return { ok: false, failures: ["ROUTING_OPERATION_INVALID"] };
  }
  const failures = commonTransitionFailures(previous, next);
  if (failures.length > 0) return { ok: false, failures };
  let transitionValid = false;
  if (operation === "producer") {
    transitionValid =
      !previous.webReadsRemote &&
      !previous.webStreamsRemote &&
      !next.webReadsRemote &&
      !next.webStreamsRemote &&
      next.producers.length > previous.producers.length &&
      previous.producers.every((producer) => next.producers.includes(producer));
  } else if (operation === "read") {
    transitionValid =
      allProducers(previous) &&
      allProducers(next) &&
      !previous.webReadsRemote &&
      !previous.webStreamsRemote &&
      next.webReadsRemote &&
      !next.webStreamsRemote;
  } else if (operation === "stream") {
    transitionValid =
      allProducers(previous) &&
      allProducers(next) &&
      previous.webReadsRemote &&
      !previous.webStreamsRemote &&
      next.webReadsRemote &&
      next.webStreamsRemote;
  } else if (["local-rollback", "final-cleanup-baseline"].includes(operation)) {
    transitionValid = !isLocal(previous) && isLocal(next);
    if (
      !finiteWatermark(next.localFallbackWatermark) ||
      next.localFallbackWatermark < next.routingWatermark
    ) {
      failures.push("LOCAL_FALLBACK_BEHIND_ROUTING_WATERMARK");
    }
  } else if (operation === "approved-final") {
    transitionValid = allProducers(next) && next.webReadsRemote && next.webStreamsRemote;
  }
  if (!transitionValid) failures.push("ROUTING_TRANSITION_SKIPPED");
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

export function allowedServicesForRoutingMutation(operation, plan) {
  const checked = validateRoutingPlan(plan);
  if (!checked.ok) throw new Error("routing plan is invalid");
  if (operation === "producer") return [...plan.producers];
  if (["read", "stream"].includes(operation)) return ["web-api"];
  if (["local-rollback", "final-cleanup-baseline"].includes(operation)) {
    return [...PRODUCERS, "web-api"];
  }
  if (operation === "approved-final") return [...PRODUCERS, "web-api"];
  throw new Error("routing operation is invalid");
}

export async function executePhase4RoutingMutation(previous, next, operation, ports) {
  const actionId = actionIdFor(operation);
  const checked = validateRoutingTransition(previous, next, operation);
  if (!checked.ok) throw new Error(`routing transition rejected: ${checked.failures.join(",")}`);
  if (
    !actionId ||
    ports?.inheritedAction?.actionId !== actionId ||
    ports.inheritedAction.releaseSha !== next.releaseSha ||
    ports.inheritedAction.stagingRunId !== ports.stagingRunId ||
    typeof ports.apply !== "function"
  ) {
    throw new Error("opaque inherited Phase 4 routing action is required");
  }
  const services = allowedServicesForRoutingMutation(operation, next);
  await ports.apply(services, Object.freeze({ ...next }));
  return { ok: true, actionId, services };
}

async function main() {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "status") {
      throw new Error("Phase 4 routing CLI is read-only status");
    }
    const plan = await readEvidenceJson(STATE_PATH, { requireCanonical: true });
    const checked = validateRoutingPlan(plan);
    console.log(
      canonicalJson({
        ...checked,
        producerCount: Array.isArray(plan.producers) ? plan.producers.length : 0,
        webReadsRemote: plan.webReadsRemote === true,
        webStreamsRemote: plan.webStreamsRemote === true,
        routingWatermark: finiteWatermark(plan.routingWatermark) ? plan.routingWatermark : 0,
      }),
    );
    if (!checked.ok) process.exitCode = 1;
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["PHASE4_ROUTING_STATUS_FAILED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("phase4-routing-guard.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
