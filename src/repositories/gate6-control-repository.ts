import { randomUUID } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STAGE = /^[a-z][a-z0-9-]{0,63}$/;
const CONTEXT_BRAND = Symbol("verified-gate6-action-context");
const MAX_PERMIT_TTL_MS = 5 * 60 * 1000;

export type Gate6ActionKind = "forward" | "compensation" | "emergency";
export type Gate6ActionStatus =
  | "registered"
  | "consumed"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "compensated"
  | "not_needed";
export type Gate6RunStatus =
  | "active"
  | "revoked"
  | "sealed-verifying"
  | "releasing"
  | "released"
  | "compensated";

export interface Gate6ActionDescriptor {
  scope: string;
  actionId: string;
  approvalSha256: string;
  allowedMutationSha256: string;
  kind: Gate6ActionKind;
  pairedActionId: string | null;
  predecessorActionIds: string[];
  requiredStage: string;
  requiredCheckerSha256: string | null;
  expiresAt: string;
}

export interface Gate6RunAdmission {
  gate6Id: string;
  gate6Nonce: string;
  envelopeSha256: string;
  envelopeCoreSha256: string;
  releaseEnvironment: "production";
  runtimeEnvironment: "production";
  drillMode: "supervised-production";
  candidateSha: string;
  candidateImageDigest: string;
  rollbackSha: string;
  rollbackImageDigest: string;
  productionTargetDescriptorSha256: string;
  operatorBundleSha256: string;
  protectedInstallEvidenceSha256: string;
  installedMigrationSetSha256: string;
  installedSchemaVersion: number;
  expiresAt: string;
  monitorLeaseExpiresAt: string;
  supervisorLeaseExpiresAt: string;
  emergencySupervisorLeaseExpiresAt: string;
  actions: Gate6ActionDescriptor[];
}

interface Gate6SlotRow {
  environment: "production";
  ownerType: "gate6";
  ownerId: string;
  state: "active" | "revoked-uncompensated" | "sealed-verifying" | "releasing" | "released";
  version: number;
  uncompensatedWork: boolean;
  protectedInstallEvidenceSha256: string;
  candidateSha: string;
  targetDescriptorSha256: string;
  operatorBundleSha256: string;
  installedSchemaVersion: number;
  heartbeatAt: string;
  expiresAt: string;
}

interface Gate6RunRow extends Omit<Gate6RunAdmission, "actions"> {
  status: Gate6RunStatus;
  currentStage: string;
  stageVersion: number;
  acceptedCheckerName: string | null;
  acceptedCheckerSha256: string | null;
  revocationReasonCode: string | null;
  monitorStatus: "green" | "red";
  supervisorStatus: "green" | "red";
  terminalEvidenceSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Gate6ActionRow extends Gate6ActionDescriptor {
  gate6Id: string;
  status: Gate6ActionStatus;
  beforeEvidenceSha256: string | null;
  afterEvidenceSha256: string | null;
  consumedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Gate6PermitRow {
  permitId: string;
  gate6Id: string;
  scope: string;
  actionId: string;
  service: "line-service" | "ocr-service";
  kind: string;
  teamId: number;
  drillSha256: string;
  targetSha256: string | null;
  fixtureSha256: string | null;
  signedPermitSha256: string;
  keyId: string;
  expiresAt: string;
  status: "armed" | "consumed" | "disarmed" | "expired";
  consumedAt: string | null;
  disarmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Gate6ControlState {
  slots: Map<string, Gate6SlotRow>;
  runs: Map<string, Gate6RunRow>;
  actions: Map<string, Gate6ActionRow>;
  permits: Map<string, Gate6PermitRow>;
}

export interface Gate6ControlStore {
  transaction<T>(callback: (state: Gate6ControlState) => Promise<T> | T): Promise<T>;
  read<T>(callback: (state: Readonly<Gate6ControlState>) => Promise<T> | T): Promise<T>;
}

class InMemoryGate6ControlStore implements Gate6ControlStore {
  private state: Gate6ControlState = emptyState();
  private tail: Promise<void> = Promise.resolve();

  async transaction<T>(callback: (state: Gate6ControlState) => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const draft = cloneState(this.state);
    try {
      const result = await callback(draft);
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }

  async read<T>(callback: (state: Readonly<Gate6ControlState>) => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    await previous;
    return callback(cloneState(this.state));
  }
}

export function createInMemoryGate6ControlStore(): Gate6ControlStore {
  return new InMemoryGate6ControlStore();
}

function emptyState(): Gate6ControlState {
  return { slots: new Map(), runs: new Map(), actions: new Map(), permits: new Map() };
}

function cloneMap<T>(value: Map<string, T>): Map<string, T> {
  return new Map([...value].map(([key, row]) => [key, structuredClone(row)]));
}

function cloneState(value: Gate6ControlState): Gate6ControlState {
  return {
    slots: cloneMap(value.slots),
    runs: cloneMap(value.runs),
    actions: cloneMap(value.actions),
    permits: cloneMap(value.permits),
  };
}

function requireId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`${label} is invalid`);
}

function requireHash(value: string | null, label: string): void {
  if (value !== null && !SHA256.test(value)) throw new Error(`${label} is invalid`);
}

function time(value: string | Date, label: string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function iso(value: string | Date, label: string): string {
  return new Date(time(value, label)).toISOString();
}

function actionKey(gate6Id: string, actionId: string): string {
  return `${gate6Id}\0${actionId}`;
}

function requireProductionRun(input: Gate6RunAdmission): void {
  requireId(input.gate6Id, "Gate 6 ID");
  requireId(input.gate6Nonce, "Gate 6 nonce");
  for (const [label, value] of [
    ["envelope hash", input.envelopeSha256],
    ["envelope core hash", input.envelopeCoreSha256],
    ["production target descriptor hash", input.productionTargetDescriptorSha256],
    ["operator bundle hash", input.operatorBundleSha256],
    ["protected install evidence hash", input.protectedInstallEvidenceSha256],
    ["installed migration set hash", input.installedMigrationSetSha256],
  ] as const) requireHash(value, label);
  if (
    input.releaseEnvironment !== "production"
    || input.runtimeEnvironment !== "production"
    || input.drillMode !== "supervised-production"
  ) throw new Error("Gate 6 production discriminators are invalid");
  if (!SHA.test(input.candidateSha) || !SHA.test(input.rollbackSha)) {
    throw new Error("Gate 6 release SHA is invalid");
  }
  if (!IMAGE.test(input.candidateImageDigest) || !IMAGE.test(input.rollbackImageDigest)) {
    throw new Error("Gate 6 image digest is invalid");
  }
  if (!Number.isSafeInteger(input.installedSchemaVersion) || input.installedSchemaVersion <= 0) {
    throw new Error("installed schema version is invalid");
  }
  const expiresAt = time(input.expiresAt, "envelope expiry");
  if (
    time(input.monitorLeaseExpiresAt, "monitor lease expiry") >= expiresAt
    || time(input.supervisorLeaseExpiresAt, "supervisor lease expiry") >= expiresAt
    || time(input.emergencySupervisorLeaseExpiresAt, "emergency supervisor lease expiry") <= expiresAt
  ) throw new Error("Gate 6 lease validity is invalid");
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    throw new Error("Gate 6 actions are required");
  }
}

function validateActionDescriptor(action: Gate6ActionDescriptor): void {
  requireId(action.scope, "action scope");
  requireId(action.actionId, "action ID");
  requireHash(action.approvalSha256, "approval hash");
  requireHash(action.allowedMutationSha256, "allowed mutation hash");
  if (!(["forward", "compensation", "emergency"] as const).includes(action.kind)) {
    throw new Error("action kind is invalid");
  }
  if (action.pairedActionId !== null) requireId(action.pairedActionId, "paired action ID");
  if (!Array.isArray(action.predecessorActionIds)) throw new Error("action predecessors are invalid");
  action.predecessorActionIds.forEach((value) => requireId(value, "predecessor action ID"));
  if (!STAGE.test(action.requiredStage)) throw new Error("required Gate 6 stage is invalid");
  requireHash(action.requiredCheckerSha256, "required checker hash");
  time(action.expiresAt, "action expiry");
}

export interface VerifiedGate6ActionContext {
  readonly status: "consumed";
  readonly gate6Id: string;
  readonly scope: string;
  readonly actionId: string;
  readonly kind: Gate6ActionKind;
  readonly consumedAt: string;
}

export interface Task9PermitReceipt {
  readonly status: "armed";
  readonly gate6Id: string;
  readonly scope: string;
  readonly actionId: string;
  readonly permitId: string;
}

function clearUncompensatedIfSafe(state: Gate6ControlState, gate6Id: string): void {
  const slot = state.slots.get("production");
  if (!slot || slot.ownerId !== gate6Id) throw new Error("Gate 6 slot state is unavailable");
  const unsafeAction = [...state.actions.values()].some((candidate) =>
    candidate.gate6Id === gate6Id && ["consumed", "failed", "ambiguous"].includes(candidate.status));
  const armedPermit = [...state.permits.values()].some((permit) =>
    permit.gate6Id === gate6Id && permit.status === "armed");
  if (!unsafeAction && !armedPermit) slot.uncompensatedWork = false;
}

function verifiedContext(row: Gate6ActionRow): VerifiedGate6ActionContext {
  const context = {
    status: "consumed" as const,
    gate6Id: row.gate6Id,
    scope: row.scope,
    actionId: row.actionId,
    kind: row.kind,
    consumedAt: row.consumedAt!,
  };
  Object.defineProperty(context, CONTEXT_BRAND, { value: randomUUID(), enumerable: false });
  return Object.freeze(context);
}

function assertContext(value: VerifiedGate6ActionContext): void {
  if (!value || typeof value !== "object" || !(CONTEXT_BRAND in value)) {
    throw new Error("verified Gate 6 action context is required");
  }
}

export class Gate6ControlRepository {
  private readonly store: Gate6ControlStore;
  private readonly now: () => Date;

  constructor(options: { store: Gate6ControlStore; now?: () => Date }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async admitRun(input: Gate6RunAdmission): Promise<void> {
    requireProductionRun(input);
    const createdAt = iso(this.now(), "repository clock");
    const actionIds = new Set<string>();
    for (const descriptor of input.actions) {
      validateActionDescriptor(descriptor);
      if (actionIds.has(descriptor.actionId)) throw new Error("Gate 6 action IDs must be unique");
      actionIds.add(descriptor.actionId);
    }
    for (const descriptor of input.actions) {
      for (const predecessor of descriptor.predecessorActionIds) {
        if (!actionIds.has(predecessor)) throw new Error("action predecessor is not registered");
      }
      if (descriptor.pairedActionId !== null && !actionIds.has(descriptor.pairedActionId)) {
        throw new Error("paired action is not registered");
      }
    }
    await this.store.transaction((state) => {
      const occupied = state.slots.get("production");
      if (occupied && occupied.state !== "released") throw new Error("production slot busy");
      if (state.runs.has(input.gate6Id)) throw new Error("Gate 6 run already exists");
      const run: Gate6RunRow = {
        ...structuredClone(input),
        status: "active",
        currentStage: "admitted",
        stageVersion: 1,
        acceptedCheckerName: null,
        acceptedCheckerSha256: null,
        revocationReasonCode: null,
        monitorStatus: "green",
        supervisorStatus: "green",
        terminalEvidenceSha256: null,
        createdAt,
        updatedAt: createdAt,
      };
      delete (run as Gate6RunRow & { actions?: Gate6ActionDescriptor[] }).actions;
      state.runs.set(input.gate6Id, run);
      state.slots.set("production", {
        environment: "production",
        ownerType: "gate6",
        ownerId: input.gate6Id,
        state: "active",
        version: (occupied?.version ?? 0) + 1,
        uncompensatedWork: false,
        protectedInstallEvidenceSha256: input.protectedInstallEvidenceSha256,
        candidateSha: input.candidateSha,
        targetDescriptorSha256: input.productionTargetDescriptorSha256,
        operatorBundleSha256: input.operatorBundleSha256,
        installedSchemaVersion: input.installedSchemaVersion,
        heartbeatAt: createdAt,
        expiresAt: iso(input.expiresAt, "envelope expiry"),
      });
      for (const descriptor of input.actions) {
        state.actions.set(actionKey(input.gate6Id, descriptor.actionId), {
          ...structuredClone(descriptor),
          gate6Id: input.gate6Id,
          status: "registered",
          beforeEvidenceSha256: null,
          afterEvidenceSha256: null,
          consumedAt: null,
          completedAt: null,
          createdAt,
          updatedAt: createdAt,
        });
      }
    });
  }

  async beginAction(input: {
    gate6Id: string;
    scope: string;
    actionId: string;
    approvalSha256: string;
    allowedMutationSha256: string;
    now?: Date;
    minimumCompensationValidityMs?: number;
  }): Promise<VerifiedGate6ActionContext> {
    const checkedAt = input.now ?? this.now();
    const result = await this.store.transaction((state) => {
      const run = state.runs.get(input.gate6Id);
      const slot = state.slots.get("production");
      if (!run || !slot || slot.ownerId !== input.gate6Id) return { error: "Gate 6 run is not active" } as const;
      if (run.status !== "active" || slot.state !== "active") return { error: "Gate 6 run is revoked" } as const;
      const checkedAtMs = time(checkedAt, "action clock");
      if (run.monitorStatus !== "green" || checkedAtMs >= time(run.monitorLeaseExpiresAt, "monitor lease")) {
        revokeState(run, slot, "monitor-lease-stale", checkedAt);
        return { error: "monitor lease is missing, stale, or red" } as const;
      }
      if (
        run.supervisorStatus !== "green"
        || checkedAtMs >= time(run.supervisorLeaseExpiresAt, "supervisor lease")
      ) {
        revokeState(run, slot, "supervisor-lease-stale", checkedAt);
        return { error: "supervisor lease is missing, stale, or red" } as const;
      }
      if (checkedAtMs >= time(run.expiresAt, "envelope expiry")) {
        revokeState(run, slot, "envelope-expired", checkedAt);
        return { error: "Gate 6 envelope is expired" } as const;
      }
      const row = state.actions.get(actionKey(input.gate6Id, input.actionId));
      if (!row || row.scope !== input.scope || row.kind === "compensation") {
        return { error: "signed action is not registered" } as const;
      }
      if (row.approvalSha256 !== input.approvalSha256) return { error: "action approval hash mismatch" } as const;
      if (row.allowedMutationSha256 !== input.allowedMutationSha256) {
        return { error: "allowed mutation hash mismatch" } as const;
      }
      if (row.status !== "registered") return { error: `action already consumed or ambiguous (${row.status})` } as const;
      if (checkedAtMs >= time(row.expiresAt, "action expiry")) return { error: "action is expired" } as const;
      if (run.currentStage !== row.requiredStage) return { error: "Gate 6 stage mismatch" } as const;
      if (row.requiredCheckerSha256 !== null && run.acceptedCheckerSha256 !== row.requiredCheckerSha256) {
        return { error: "semantic checker hash mismatch" } as const;
      }
      for (const predecessor of row.predecessorActionIds) {
        const predecessorRow = state.actions.get(actionKey(input.gate6Id, predecessor));
        if (!predecessorRow || !["succeeded", "compensated", "not_needed"].includes(predecessorRow.status)) {
          return { error: "predecessor evidence is incomplete" } as const;
        }
      }
      const recovery = [...state.actions.values()].find((candidate) =>
        candidate.gate6Id === input.gate6Id
        && candidate.kind === "compensation"
        && candidate.pairedActionId === row.actionId);
      const minimumRecovery = input.minimumCompensationValidityMs ?? 0;
      if (recovery && time(recovery.expiresAt, "compensation expiry") <= checkedAtMs + minimumRecovery) {
        return { error: "compensation validity is insufficient" } as const;
      }
      row.status = "consumed";
      row.consumedAt = iso(checkedAt, "action clock");
      row.updatedAt = row.consumedAt;
      slot.uncompensatedWork = true;
      slot.heartbeatAt = row.consumedAt;
      return { context: verifiedContext(row) } as const;
    });
    if ("error" in result) throw new Error(result.error);
    return result.context;
  }

  async beginCompensation(input: {
    gate6Id: string;
    scope: string;
    actionId: string;
    approvalSha256: string;
    allowedMutationSha256: string;
    pairedActionId: string;
    now?: Date;
  }): Promise<VerifiedGate6ActionContext> {
    const checkedAt = input.now ?? this.now();
    const result = await this.store.transaction((state) => {
      const run = state.runs.get(input.gate6Id);
      const slot = state.slots.get("production");
      if (!run || !slot || slot.ownerId !== input.gate6Id) return { error: "Gate 6 run is unavailable" } as const;
      if (run.status !== "revoked") return { error: "compensation requires a revoked run" } as const;
      if (time(checkedAt, "compensation clock") >= time(run.emergencySupervisorLeaseExpiresAt, "emergency lease")) {
        return { error: "emergency supervisor lease is stale" } as const;
      }
      const row = state.actions.get(actionKey(input.gate6Id, input.actionId));
      if (
        !row
        || row.kind !== "compensation"
        || row.scope !== input.scope
        || row.pairedActionId !== input.pairedActionId
      ) return { error: "signed compensation is not registered" } as const;
      if (row.approvalSha256 !== input.approvalSha256) return { error: "compensation approval hash mismatch" } as const;
      if (row.allowedMutationSha256 !== input.allowedMutationSha256) {
        return { error: "compensation mutation hash mismatch" } as const;
      }
      if (row.status !== "registered") return { error: `compensation already consumed (${row.status})` } as const;
      if (time(checkedAt, "compensation clock") >= time(row.expiresAt, "compensation expiry")) {
        return { error: "compensation is expired" } as const;
      }
      const original = state.actions.get(actionKey(input.gate6Id, input.pairedActionId));
      if (!original || original.status === "registered") return { error: "paired forward action has no work to restore" } as const;
      row.status = "consumed";
      row.consumedAt = iso(checkedAt, "compensation clock");
      row.updatedAt = row.consumedAt;
      return { context: verifiedContext(row) } as const;
    });
    if ("error" in result) throw new Error(result.error);
    return result.context;
  }

  async finishAction(
    context: VerifiedGate6ActionContext,
    input: {
      status: "succeeded" | "failed" | "ambiguous";
      afterEvidenceSha256: string;
      now?: Date;
    },
  ): Promise<void> {
    assertContext(context);
    requireHash(input.afterEvidenceSha256, "action evidence hash");
    const completedAt = iso(input.now ?? this.now(), "action completion clock");
    await this.store.transaction((state) => {
      const row = state.actions.get(actionKey(context.gate6Id, context.actionId));
      if (!row || row.status !== "consumed") throw new Error("action is not in consumed state");
      row.status = input.status;
      row.afterEvidenceSha256 = input.afterEvidenceSha256;
      row.completedAt = completedAt;
      row.updatedAt = completedAt;
      const run = state.runs.get(context.gate6Id);
      const slot = state.slots.get("production");
      if (!run || !slot) throw new Error("Gate 6 run state is unavailable");
      if (input.status !== "succeeded") revokeState(run, slot, "action-not-succeeded", completedAt);
      if (row.kind === "compensation" && input.status === "succeeded" && row.pairedActionId) {
        const original = state.actions.get(actionKey(context.gate6Id, row.pairedActionId));
        if (original) original.status = "compensated";
      }
      if (input.status === "succeeded") clearUncompensatedIfSafe(state, context.gate6Id);
    });
  }

  async acceptSemanticChecker(
    context: VerifiedGate6ActionContext,
    input: { checkerName: string; checkerSha256: string; nextStage: string; now?: Date },
  ): Promise<void> {
    assertContext(context);
    requireId(input.checkerName, "semantic checker name");
    requireHash(input.checkerSha256, "semantic checker hash");
    if (!STAGE.test(input.nextStage)) throw new Error("next Gate 6 stage is invalid");
    const acceptedAt = iso(input.now ?? this.now(), "semantic checker clock");
    await this.store.transaction((state) => {
      const row = state.actions.get(actionKey(context.gate6Id, context.actionId));
      const run = state.runs.get(context.gate6Id);
      if (!row || !run || row.status !== "consumed" || run.status !== "active") {
        throw new Error("semantic checker action is not consumable");
      }
      row.status = "succeeded";
      row.afterEvidenceSha256 = input.checkerSha256;
      row.completedAt = acceptedAt;
      row.updatedAt = acceptedAt;
      run.currentStage = input.nextStage;
      run.stageVersion += 1;
      run.acceptedCheckerName = input.checkerName;
      run.acceptedCheckerSha256 = input.checkerSha256;
      run.updatedAt = acceptedAt;
      for (const candidate of state.actions.values()) {
        if (
          candidate.gate6Id === context.gate6Id
          && candidate.requiredStage === input.nextStage
          && candidate.requiredCheckerSha256 === null
          && candidate.status === "registered"
        ) candidate.requiredCheckerSha256 = input.checkerSha256;
      }
      clearUncompensatedIfSafe(state, context.gate6Id);
    });
  }

  async revokeRun(input: { gate6Id: string; reasonCode: string; now?: Date }): Promise<void> {
    requireId(input.reasonCode, "revocation reason code");
    await this.store.transaction((state) => {
      const run = state.runs.get(input.gate6Id);
      const slot = state.slots.get("production");
      if (!run || !slot || slot.ownerId !== input.gate6Id) throw new Error("Gate 6 run is unavailable");
      if (["released", "compensated"].includes(run.status)) throw new Error("terminal Gate 6 run cannot be revoked");
      revokeState(run, slot, input.reasonCode, input.now ?? this.now());
    });
  }

  async renewLease(input: {
    gate6Id: string;
    lease: "monitor" | "supervisor";
    status: "green" | "red";
    expiresAt: string;
    now?: Date;
  }): Promise<void> {
    const checkedAt = iso(input.now ?? this.now(), "lease clock");
    if (time(input.expiresAt, "lease expiry") <= time(checkedAt, "lease clock")) {
      throw new Error("lease expiry must be in the future");
    }
    await this.store.transaction((state) => {
      const run = state.runs.get(input.gate6Id);
      const slot = state.slots.get("production");
      if (!run || !slot || slot.ownerId !== input.gate6Id) throw new Error("Gate 6 run is unavailable");
      if (input.lease === "monitor") {
        run.monitorStatus = input.status;
        run.monitorLeaseExpiresAt = iso(input.expiresAt, "monitor lease expiry");
      } else {
        run.supervisorStatus = input.status;
        run.supervisorLeaseExpiresAt = iso(input.expiresAt, "supervisor lease expiry");
      }
      run.updatedAt = checkedAt;
      slot.heartbeatAt = checkedAt;
      if (input.status === "red") revokeState(run, slot, `${input.lease}-red`, checkedAt);
    });
  }

  async registerTask9Permit(input: {
    gate6Id: string;
    scope: string;
    actionId: string;
    approvalSha256: string;
    allowedMutationSha256: string;
    permitId: string;
    service: "line-service" | "ocr-service";
    kind: string;
    teamId: number;
    drillSha256: string;
    targetSha256: string | null;
    fixtureSha256: string | null;
    signedPermitSha256: string;
    keyId: string;
    expectedCheckerSha256: string;
    expiresAt: string;
    now?: Date;
  }): Promise<Task9PermitReceipt> {
    requireId(input.permitId, "permit ID");
    requireId(input.kind, "permit kind");
    requireId(input.keyId, "permit key ID");
    requireHash(input.drillSha256, "permit drill hash");
    requireHash(input.expectedCheckerSha256, "permit accepted checker hash");
    requireHash(input.targetSha256, "permit target hash");
    requireHash(input.fixtureSha256, "permit fixture hash");
    requireHash(input.signedPermitSha256, "signed permit hash");
    if (!Number.isSafeInteger(input.teamId) || input.teamId <= 0) throw new Error("permit team is invalid");
    const checkedAt = input.now ?? this.now();
    const ttl = time(input.expiresAt, "permit expiry") - time(checkedAt, "permit clock");
    if (ttl <= 5_000 || ttl > MAX_PERMIT_TTL_MS) throw new Error("permit TTL is outside the bounded window");
    await this.store.transaction((state) => {
      const run = state.runs.get(input.gate6Id);
      const slot = state.slots.get("production");
      const action = state.actions.get(actionKey(input.gate6Id, input.actionId));
      const checkedAtMs = time(checkedAt, "permit clock");
      if (!run || !slot || slot.ownerId !== input.gate6Id || run.status !== "active" || slot.state !== "active") {
        throw new Error("Task 9 Gate 6 run is not active");
      }
      if (
        run.currentStage !== "db-transition-stable"
        || run.acceptedCheckerSha256 !== input.expectedCheckerSha256
      ) {
        throw new Error("Task 9 permit stage is not active");
      }
      if (
        run.monitorStatus !== "green"
        || checkedAtMs >= time(run.monitorLeaseExpiresAt, "monitor lease")
        || run.supervisorStatus !== "green"
        || checkedAtMs >= time(run.supervisorLeaseExpiresAt, "supervisor lease")
        || checkedAtMs >= time(run.expiresAt, "envelope expiry")
      ) throw new Error("Task 9 liveness lease is missing or stale");
      if (
        !action
        || action.scope !== input.scope
        || action.status !== "registered"
        || action.approvalSha256 !== input.approvalSha256
        || action.allowedMutationSha256 !== input.allowedMutationSha256
        || !action.scope.includes(input.service === "line-service" ? "line" : "ocr")
      ) {
        throw new Error("Task 9 permit intent does not match the registered action");
      }
      if (checkedAtMs >= time(action.expiresAt, "action expiry")) throw new Error("Task 9 action is expired");
      for (const predecessor of action.predecessorActionIds) {
        const predecessorRow = state.actions.get(actionKey(input.gate6Id, predecessor));
        if (!predecessorRow || predecessorRow.status !== "succeeded") {
          throw new Error("Task 9 predecessor evidence is incomplete");
        }
      }
      if (state.permits.has(input.permitId)) throw new Error("Task 9 permit is already registered");
      const createdAt = iso(checkedAt, "permit clock");
      state.permits.set(input.permitId, {
        ...structuredClone(input),
        status: "armed",
        consumedAt: null,
        disarmedAt: null,
        createdAt,
        updatedAt: createdAt,
      });
      action.status = "consumed";
      action.consumedAt = createdAt;
      action.updatedAt = createdAt;
      slot.uncompensatedWork = true;
      slot.heartbeatAt = createdAt;
    });
    return Object.freeze({
      status: "armed",
      gate6Id: input.gate6Id,
      scope: input.scope,
      actionId: input.actionId,
      permitId: input.permitId,
    });
  }

  async completeTask9PermitAction(
    receipt: Task9PermitReceipt,
    input: { status: "succeeded" | "ambiguous"; afterEvidenceSha256: string; now?: Date },
  ): Promise<void> {
    requireHash(input.afterEvidenceSha256, "Task 9 evidence hash");
    if (!["succeeded", "ambiguous"].includes(input.status)) {
      throw new Error("Task 9 completion status is invalid");
    }
    const completedAt = iso(input.now ?? this.now(), "Task 9 completion clock");
    await this.store.transaction((state) => {
      const action = state.actions.get(actionKey(receipt.gate6Id, receipt.actionId));
      const permit = state.permits.get(receipt.permitId);
      if (
        receipt.status !== "armed"
        || !action
        || action.scope !== receipt.scope
        || action.status !== "consumed"
        || !permit
        || permit.gate6Id !== receipt.gate6Id
        || permit.scope !== receipt.scope
        || permit.actionId !== receipt.actionId
        || !["consumed", "disarmed"].includes(permit.status)
        || permit.disarmedAt === null
      ) throw new Error("Task 9 action or permit is not terminal");
      action.status = input.status;
      action.afterEvidenceSha256 = input.afterEvidenceSha256;
      action.completedAt = completedAt;
      action.updatedAt = completedAt;
      if (input.status === "succeeded") {
        clearUncompensatedIfSafe(state, receipt.gate6Id);
      } else {
        const run = state.runs.get(receipt.gate6Id);
        const slot = state.slots.get("production");
        if (!run || !slot) throw new Error("Task 9 Gate 6 run state is unavailable");
        revokeState(run, slot, "task9-controller-failure", completedAt);
      }
    });
  }

  async consumeTask9Permit(input: {
    permitId: string;
    service: "line-service" | "ocr-service";
    teamId: number;
    signedPermitSha256: string;
    targetSha256?: string;
    fixtureSha256?: string;
    now?: Date;
  }): Promise<{ status: "consumed" }> {
    requireHash(input.signedPermitSha256, "signed permit hash");
    const result = await this.store.transaction((state) => {
      const permit = state.permits.get(input.permitId);
      if (!permit) throw new Error("Task 9 permit is unavailable");
      if (permit.status === "consumed") throw new Error("Task 9 permit was already consumed");
      if (permit.status !== "armed") throw new Error("Task 9 permit is not armed");
      if (time(input.now ?? this.now(), "permit clock") >= time(permit.expiresAt, "permit expiry")) {
        permit.status = "expired";
        permit.updatedAt = iso(input.now ?? this.now(), "permit clock");
        return { error: "Task 9 permit is expired" } as const;
      }
      if (
        permit.service !== input.service
        || permit.teamId !== input.teamId
        || permit.signedPermitSha256 !== input.signedPermitSha256
        || (permit.targetSha256 !== null && permit.targetSha256 !== input.targetSha256)
        || (permit.fixtureSha256 !== null && permit.fixtureSha256 !== input.fixtureSha256)
      ) throw new Error("Task 9 permit request does not match");
      permit.status = "consumed";
      permit.consumedAt = iso(input.now ?? this.now(), "permit clock");
      permit.updatedAt = permit.consumedAt;
      return { status: "consumed" } as const;
    });
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  async disarmTask9Permit(input: { permitId: string; now?: Date }): Promise<void> {
    await this.store.transaction((state) => {
      const permit = state.permits.get(input.permitId);
      if (!permit) return;
      if (permit.status === "armed") permit.status = "disarmed";
      permit.disarmedAt = iso(input.now ?? this.now(), "permit disarm clock");
      permit.updatedAt = permit.disarmedAt;
    });
  }

  async getRun(gate6Id: string): Promise<Gate6RunRow | null> {
    return this.store.read((state) => structuredClone(state.runs.get(gate6Id) ?? null));
  }

  async getSanitizedSnapshot(gate6Id: string): Promise<{
    gate6Id: string;
    status: Gate6RunStatus;
    currentStage: string;
    stageVersion: number;
    acceptedCheckerName: string | null;
    acceptedCheckerSha256: string | null;
    slotState: string;
    actionCounts: Record<string, number>;
    activePermitCount: number;
    terminalEvidenceSha256: string | null;
    updatedAt: string;
  }> {
    return this.store.read((state) => {
      const run = state.runs.get(gate6Id);
      const slot = state.slots.get("production");
      if (!run || !slot || slot.ownerId !== gate6Id) throw new Error("Gate 6 run is unavailable");
      const actionCounts: Record<string, number> = {};
      for (const row of state.actions.values()) {
        if (row.gate6Id !== gate6Id) continue;
        const key = `${row.kind}:${row.status}`;
        actionCounts[key] = (actionCounts[key] ?? 0) + 1;
      }
      const activePermitCount = [...state.permits.values()].filter((permit) =>
        permit.gate6Id === gate6Id && permit.status === "armed").length;
      return {
        gate6Id,
        status: run.status,
        currentStage: run.currentStage,
        stageVersion: run.stageVersion,
        acceptedCheckerName: run.acceptedCheckerName,
        acceptedCheckerSha256: run.acceptedCheckerSha256,
        slotState: slot.state,
        actionCounts,
        activePermitCount,
        terminalEvidenceSha256: run.terminalEvidenceSha256,
        updatedAt: run.updatedAt,
      };
    });
  }
}

function revokeState(
  run: Gate6RunRow,
  slot: Gate6SlotRow,
  reasonCode: string,
  at: string | Date,
): void {
  const timestamp = iso(at, "revocation clock");
  run.status = "revoked";
  run.revocationReasonCode = reasonCode;
  run.updatedAt = timestamp;
  slot.state = "revoked-uncompensated";
  slot.uncompensatedWork = true;
  slot.heartbeatAt = timestamp;
}
