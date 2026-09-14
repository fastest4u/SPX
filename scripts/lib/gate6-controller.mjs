import { canonicalJson } from "./evidence-artifact.mjs";

export const PRODUCTION_COMPOSE = Object.freeze({
  project: "spx-production",
  envFile: "/root/SPX/.env",
  files: Object.freeze(["/root/SPX/docker-compose.yml"]),
});

const contexts = new WeakMap();

function assertProductionAction(action) {
  if (
    action?.releaseEnvironment !== "production"
    || action?.runtimeEnvironment !== "production"
    || action?.drillMode !== "supervised-production"
  ) throw new Error("Gate 6 production discriminator mismatch");
  if (
    action.composeProject !== PRODUCTION_COMPOSE.project
    || action.envFile !== PRODUCTION_COMPOSE.envFile
    || canonicalJson(action.composeFiles) !== canonicalJson(PRODUCTION_COMPOSE.files)
  ) throw new Error("Gate 6 production boundary mismatch");
}

function opaqueContext(action, kind, durableReceipt) {
  const context = Object.freeze({});
  contexts.set(context, {
    gate6Id: action.gate6Id,
    scope: action.scope,
    actionId: action.actionId,
    approvalSha256: action.approvalSha256,
    allowedMutationSha256: action.allowedMutationSha256,
    kind,
    durableReceipt,
    consumed: false,
  });
  return context;
}

export async function authorizeGate6ForwardMutation({ ledger, action, now }) {
  assertProductionAction(action);
  if (!ledger || typeof ledger.beginAction !== "function") throw new Error("Gate 6 ledger is unavailable");
  const durableReceipt = await ledger.beginAction({
    gate6Id: action.gate6Id,
    scope: action.scope,
    actionId: action.actionId,
    approvalSha256: action.approvalSha256,
    allowedMutationSha256: action.allowedMutationSha256,
    now,
    minimumCompensationValidityMs: action.minimumCompensationValidityMs,
    envelopeSha256: action.envelopeSha256,
    envelopeCoreSha256: action.envelopeCoreSha256,
    expectedStage: action.expectedStage,
    expectedCheckerSha256: action.expectedCheckerSha256,
  });
  return opaqueContext(action, "forward", durableReceipt);
}

export async function authorizeGate6CompensationMutation({ ledger, action, now }) {
  assertProductionAction(action);
  if (action.kind !== "compensation" || typeof action.pairedActionId !== "string") {
    throw new Error("Gate 6 compensation binding is invalid");
  }
  if (!ledger || typeof ledger.beginCompensation !== "function") throw new Error("Gate 6 ledger is unavailable");
  const durableReceipt = await ledger.beginCompensation({
    gate6Id: action.gate6Id,
    scope: action.scope,
    actionId: action.actionId,
    approvalSha256: action.approvalSha256,
    allowedMutationSha256: action.allowedMutationSha256,
    pairedActionId: action.pairedActionId,
    now,
  });
  return opaqueContext(action, "compensation", durableReceipt);
}

export function inspectGate6MutationContext(context, expectedScope, expectedKind = undefined) {
  const state = contexts.get(context);
  if (!state) throw new Error("verified Gate 6 mutation context is required");
  if (state.scope !== expectedScope || (expectedKind !== undefined && state.kind !== expectedKind)) {
    throw new Error("verified Gate 6 mutation context scope mismatch");
  }
  return Object.freeze({
    gate6Id: state.gate6Id,
    scope: state.scope,
    actionId: state.actionId,
    approvalSha256: state.approvalSha256,
    allowedMutationSha256: state.allowedMutationSha256,
    kind: state.kind,
  });
}

export function consumeGate6MutationContext(context, expectedScope, expectedKind = undefined) {
  const state = contexts.get(context);
  if (!state) throw new Error("verified Gate 6 mutation context is required");
  if (state.consumed) throw new Error("verified Gate 6 mutation context was already consumed");
  const inspected = inspectGate6MutationContext(context, expectedScope, expectedKind);
  state.consumed = true;
  return inspected;
}

export async function completeGate6MutationContext(context, ledger, input) {
  const state = contexts.get(context);
  if (!state || state.consumed !== true) throw new Error("consumed Gate 6 mutation context is required");
  if (state.completed) throw new Error("Gate 6 mutation context was already completed");
  if (!ledger || typeof ledger.finishAction !== "function") throw new Error("Gate 6 ledger completion is unavailable");
  await ledger.finishAction(state.durableReceipt, input);
  state.completed = true;
}
