import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJson, sha256Canonical } from "./evidence-artifact.mjs";
import {
  assertTrustedStagingOperationRegistry,
  createProductionStagingOperationRegistry,
} from "./staging-operation-registry.mjs";

const DEFAULT_ROOT_PATH = "/var/lib/spx-staging-rollout";
const JOURNAL_FILENAME = "actions.jsonl";
const LOCK_FILENAME = "actions.lock";
const ZERO_HASH = "0".repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const BINDING_FIELDS = [
  "approvalId",
  "stagingRunId",
  "approvalEnvelopeSha256",
  "targetDescriptorSha256",
  "operatorBundleSha256",
];
const PERSISTED_ACTION_FIELDS = [
  "approvalId",
  "stagingRunId",
  "approvalEnvelopeSha256",
  "targetDescriptorSha256",
  "operatorBundleSha256",
  "sequence",
  "actionId",
  "scope",
  "kind",
  "mutationSha256",
  "notBefore",
  "expiresAt",
];
const SNAPSHOT_FIELDS = ["schemaVersion", "binding", "recordCount", "headSha256", "actions"];
const SNAPSHOT_ACTION_FIELDS = [
  "sequence",
  "actionId",
  "scope",
  "kind",
  "mutationSha256",
  "state",
  "occurrences",
  "terminalRecordSha256",
  "completedAt",
  "reconciliationId",
  "reconciliationOutcome",
];
const JOURNAL_STATES = new Set([
  "registered",
  "ambiguous",
  "succeeded",
  "failed",
  "reconciled",
  "compensated",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} has an invalid or unknown field`);
  }
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a concrete bounded identifier`);
  }
}

function parseTime(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} is invalid`);
  return time;
}

function freezeClone(value) {
  const clone = structuredClone(value);
  const visit = (item) => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.freeze(item);
      Object.values(item).forEach(visit);
    }
  };
  visit(clone);
  return clone;
}

function snapshotBinding(binding) {
  return Object.fromEntries(BINDING_FIELDS.map((field) => [field, binding[field]]));
}

function normalizeOperationResult(value) {
  assertExactKeys(value, ["ok", "code"], "staging operation result");
  if (value.ok !== true) throw new Error("staging operation result must report success");
  assertId(value.code, "staging operation result code");
  return Object.freeze({ ok: true, code: value.code });
}

function bindingFromAction(action) {
  return Object.fromEntries(BINDING_FIELDS.map((field) => [field, action[field]]));
}

function persistedAction(action) {
  const result = Object.fromEntries(PERSISTED_ACTION_FIELDS.map((field) => [field, action[field]]));
  if (action.kind === "compensation") result.compensatesActionId = action.compensatesActionId;
  return result;
}

export function stagingActionKey(action) {
  assertObject(action, "staging action");
  assertId(action.approvalId, "approval ID");
  assertId(action.scope, "action scope");
  assertId(action.actionId, "action ID");
  return canonicalJson([action.approvalId, action.scope, action.actionId]);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw new Error("durability sync target must be a directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function recordFields(event) {
  const common = [
    "version",
    "recordNumber",
    "recordedAt",
    "binding",
    "event",
    "previousRecordSha256",
    "recordSha256",
  ];
  const specific = {
    registered: ["action"],
    consumed: ["actionKey", "mutationSha256"],
    succeeded: ["actionKey", "resultSha256"],
    failed: ["actionKey", "errorSha256"],
    reconciled: ["actionKey", "reconciliationId", "outcome", "postconditionSha256"],
    compensated: ["actionKey", "compensationActionKey"],
  }[event];
  if (!specific) throw new Error("action journal contains an unknown event");
  return [...common, ...specific];
}

function applyJournalRecord(actions, states, record) {
  if (record.event === "registered") {
    const key = stagingActionKey(record.action);
    if (actions.has(key)) throw new Error("action journal contains a duplicate registration");
    actions.set(key, freezeClone(record.action));
    states.set(key, "registered");
    return;
  }
  const current = states.get(record.actionKey);
  if (!current) throw new Error("action journal references an unregistered action");
  const descriptor = actions.get(record.actionKey);
  if (!descriptor) throw new Error("action journal references a missing action registration");
  if (record.event === "consumed") {
    assertHash(record.mutationSha256, "action journal consumed mutation hash");
    if (record.mutationSha256 !== descriptor.mutationSha256) {
      throw new Error("action journal consumed mutation hash does not match its registration");
    }
    if (current !== "registered") throw new Error("action journal contains a replayed consumption");
    states.set(record.actionKey, "ambiguous");
  } else if (record.event === "succeeded") {
    assertHash(record.resultSha256, "action journal success result hash");
    if (current !== "ambiguous") throw new Error("action journal success has no consumption");
    states.set(record.actionKey, "succeeded");
  } else if (record.event === "failed") {
    assertHash(record.errorSha256, "action journal failure error hash");
    if (current !== "ambiguous") throw new Error("action journal failure has no consumption");
    states.set(record.actionKey, "failed");
  } else if (record.event === "reconciled") {
    assertId(record.reconciliationId, "action journal reconciliation ID");
    if (!["succeeded", "failed"].includes(record.outcome)) {
      throw new Error("action journal reconciliation outcome is invalid");
    }
    assertHash(record.postconditionSha256, "action journal reconciliation postcondition hash");
    if (current !== "ambiguous") {
      throw new Error("action journal reconciliation is not admissible");
    }
    states.set(record.actionKey, record.outcome === "succeeded" ? "reconciled" : "failed");
  } else if (record.event === "compensated") {
    if (!["ambiguous", "failed"].includes(current)) {
      throw new Error("action journal compensation is not admissible");
    }
    const compensation = actions.get(record.compensationActionKey);
    if (
      !compensation ||
      compensation.kind !== "compensation" ||
      compensation.compensatesActionId !== descriptor.actionId
    ) {
      throw new Error("action journal compensation action relation is invalid");
    }
    if (!["succeeded", "reconciled"].includes(states.get(record.compensationActionKey))) {
      throw new Error("action journal compensation action has no terminal success");
    }
    states.set(record.actionKey, "compensated");
  }
}

function replayJournalRecords(records) {
  const actions = new Map();
  const states = new Map();
  for (const record of records) applyJournalRecord(actions, states, record);
  return { actions, states };
}

function buildOrderedJournalSnapshot({ binding, records, actions, states, headSha256 }) {
  if (!Array.isArray(records) || !(actions instanceof Map) || !(states instanceof Map)) {
    throw new Error("action journal snapshot state is invalid");
  }
  assertHash(headSha256, "action journal snapshot head");
  const expectedHeadSha256 = records.at(-1)?.recordSha256 ?? ZERO_HASH;
  if (headSha256 !== expectedHeadSha256) {
    throw new Error("action journal snapshot head is absent from the validated chain");
  }
  if (states.size !== actions.size) {
    throw new Error("action journal snapshot contains a missing registration");
  }

  const registrations = new Map();
  const recordHashes = new Set();
  const terminalSuccesses = new Map();
  for (const record of records) {
    if (recordHashes.has(record.recordSha256)) {
      throw new Error("action journal snapshot contains a duplicate record hash");
    }
    recordHashes.add(record.recordSha256);
    if (record.event === "registered") {
      const key = stagingActionKey(record.action);
      registrations.set(key, (registrations.get(key) ?? 0) + 1);
    }
    if (
      record.event === "succeeded" ||
      (record.event === "reconciled" && record.outcome === "succeeded")
    ) {
      const entries = terminalSuccesses.get(record.actionKey) ?? [];
      entries.push(record);
      terminalSuccesses.set(record.actionKey, entries);
    }
  }

  const orderedActions = [...actions.entries()].sort(
    ([, left], [, right]) => left.sequence - right.sequence,
  );
  if (orderedActions.length === 0 || registrations.size !== orderedActions.length) {
    throw new Error("action journal snapshot contains a missing registration");
  }
  const actionIds = new Set();
  const snapshotActions = orderedActions.map(([key, descriptor], index) => {
    const expectedActionFields =
      descriptor.kind === "compensation"
        ? [...PERSISTED_ACTION_FIELDS, "compensatesActionId"]
        : PERSISTED_ACTION_FIELDS;
    assertExactKeys(descriptor, expectedActionFields, "registered action");
    if (descriptor.sequence !== index + 1) {
      throw new Error("action journal snapshot action sequence is not contiguous");
    }
    assertId(descriptor.actionId, "snapshot action ID");
    assertId(descriptor.scope, "snapshot action scope");
    if (actionIds.has(descriptor.actionId)) {
      throw new Error("action journal snapshot action IDs are not unique");
    }
    actionIds.add(descriptor.actionId);
    if (!["forward", "compensation", "emergency"].includes(descriptor.kind)) {
      throw new Error("action journal snapshot action kind is invalid");
    }
    assertHash(descriptor.mutationSha256, "snapshot action mutation hash");
    if (
      key !== stagingActionKey(descriptor) ||
      canonicalJson(bindingFromAction(descriptor)) !== canonicalJson(binding)
    ) {
      throw new Error("action journal snapshot action binding is invalid");
    }
    if (registrations.get(key) !== 1) {
      throw new Error("action journal snapshot contains a duplicate registration");
    }

    const state = states.get(key);
    if (!JOURNAL_STATES.has(state)) {
      throw new Error("action journal snapshot contains an unknown state");
    }
    const terminals = terminalSuccesses.get(key) ?? [];
    if (terminals.length > 1) {
      throw new Error("action journal snapshot contains a duplicate terminal success");
    }
    const hasTerminalState = state === "succeeded" || state === "reconciled";
    if ((hasTerminalState && terminals.length !== 1) || (!hasTerminalState && terminals.length !== 0)) {
      throw new Error("action journal snapshot terminal success does not match action state");
    }
    const terminal = terminals[0] ?? null;
    if (terminal && !recordHashes.has(terminal.recordSha256)) {
      throw new Error("action journal snapshot terminal is absent from the validated chain");
    }
    if (state === "succeeded" && terminal?.event !== "succeeded") {
      throw new Error("action journal snapshot ordinary success is invalid");
    }
    if (
      state === "reconciled" &&
      (terminal?.event !== "reconciled" || terminal.outcome !== "succeeded")
    ) {
      throw new Error("action journal snapshot reconciliation outcome is not succeeded");
    }

    return {
      sequence: descriptor.sequence,
      actionId: descriptor.actionId,
      scope: descriptor.scope,
      kind: descriptor.kind,
      mutationSha256: descriptor.mutationSha256,
      state,
      occurrences: terminals.length,
      terminalRecordSha256: terminal?.recordSha256 ?? null,
      completedAt: terminal?.recordedAt ?? null,
      reconciliationId: terminal?.event === "reconciled" ? terminal.reconciliationId : null,
      reconciliationOutcome: terminal?.event === "reconciled" ? terminal.outcome : null,
    };
  });

  return {
    schemaVersion: 1,
    binding: snapshotBinding(binding),
    recordCount: records.length,
    headSha256,
    actions: snapshotActions,
  };
}

function assertSnapshotShape(snapshot) {
  assertExactKeys(snapshot, SNAPSHOT_FIELDS, "action journal snapshot");
  if (snapshot.schemaVersion !== 1) {
    throw new Error("action journal snapshot schema version is invalid");
  }
  assertExactKeys(snapshot.binding, BINDING_FIELDS, "action journal snapshot binding");
  if (!Number.isSafeInteger(snapshot.recordCount) || snapshot.recordCount <= 0) {
    throw new Error("action journal snapshot record count is invalid");
  }
  assertHash(snapshot.headSha256, "action journal snapshot head");
  if (!Array.isArray(snapshot.actions) || snapshot.actions.length === 0) {
    throw new Error("action journal snapshot actions are invalid");
  }
  for (const entry of snapshot.actions) {
    assertExactKeys(entry, SNAPSHOT_ACTION_FIELDS, "action journal snapshot action");
  }
}

class StagingActionLedger {
  constructor(options) {
    this.rootPath = resolve(options.rootPath ?? DEFAULT_ROOT_PATH);
    this.journalPath = join(this.rootPath, JOURNAL_FILENAME);
    this.lockPath = join(this.rootPath, LOCK_FILENAME);
    this.binding = freezeClone(options.binding);
    this.verifyAction = options.verifyAction;
    this.verifyReconciliation = options.verifyReconciliation ?? options.verifyAction;
    this.now = options.now ?? (() => new Date());
    this.enforceMode = options.enforceMode ?? process.platform !== "win32";
    this.enforceOwnership =
      options.enforceOwnership ??
      (process.platform !== "win32" && this.rootPath === resolve(DEFAULT_ROOT_PATH));
    this.expectedOwnerUid = options.expectedOwnerUid ?? 0;
    this.lockStrategy =
      options.lockStrategy ?? (process.platform === "win32" ? "exclusive-file" : "native-flock");
    if (!["exclusive-file", "native-flock"].includes(this.lockStrategy)) {
      throw new Error("action journal lock strategy is invalid");
    }
    if (options.operationRegistry !== undefined && process.env.NODE_ENV !== "test") {
      throw new Error("caller-selected staging operation registries are forbidden");
    }
    this.operationRegistry = options.operationRegistry;
    this.testHooks = process.env.NODE_ENV === "test" ? (options.testHooks ?? {}) : {};
    this.records = [];
    this.actions = new Map();
    this.states = new Map();
    this.headHash = ZERO_HASH;
    this.closed = false;
  }

  async initialize(actions) {
    if (typeof this.verifyAction !== "function") {
      throw new Error("a signed action verifier is required");
    }
    this.validateBinding(this.binding);
    this.operationRegistry = assertTrustedStagingOperationRegistry(
      this.operationRegistry ?? createProductionStagingOperationRegistry(actions),
      actions,
    );
    const rootExisted = await lstat(this.rootPath).then(
      () => true,
      (error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      },
    );
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    if (!rootExisted) await fsyncDirectory(dirname(this.rootPath));
    const rootRealPath = resolve(await realpath(this.rootPath));
    const pathMatches =
      process.platform === "win32"
        ? rootRealPath.toLowerCase() === this.rootPath.toLowerCase()
        : rootRealPath === this.rootPath;
    if (!pathMatches) {
      throw new Error("action journal root path must not contain a symlink");
    }
    const rootStat = await lstat(this.rootPath, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("action journal root must be a regular directory");
    }
    if (this.enforceMode && Number(rootStat.mode & 0o777n) !== 0o700) {
      throw new Error("action journal root must use mode 0700");
    }
    if (this.enforceOwnership && Number(rootStat.uid) !== this.expectedOwnerUid) {
      throw new Error("action journal root has invalid ownership");
    }
    await this.ensureJournalExists();
    await this.withLock(async () => {
      await this.reload();
      const sortedActions = [...actions].sort((left, right) => left.sequence - right.sequence);
      const actionIds = new Set();
      for (const [index, action] of sortedActions.entries()) {
        if (action.sequence !== index + 1) {
          throw new Error("verified actions must use a contiguous sequence starting at one");
        }
        if (actionIds.has(action.actionId)) throw new Error("verified action IDs must be unique");
        actionIds.add(action.actionId);
        await this.validateAction(action, { enforceTime: false });
        const key = stagingActionKey(action);
        const existing = this.actions.get(key);
        if (existing) {
          this.assertRegisteredActionMatches(action, existing);
          continue;
        }
        await this.appendRecord({ event: "registered", action: persistedAction(action) });
      }
      const approvedActionKeys = new Set(sortedActions.map((action) => stagingActionKey(action)));
      for (const key of this.actions.keys()) {
        if (!approvedActionKeys.has(key)) {
          throw new Error("action journal contains an action outside the signed action sequence");
        }
      }
      await this.recoverCompletedCompensations();
    });
    return this;
  }

  validateBinding(binding) {
    assertExactKeys(binding, BINDING_FIELDS, "action journal binding");
    assertId(binding.approvalId, "approval ID");
    assertId(binding.stagingRunId, "staging run ID");
    assertHash(binding.approvalEnvelopeSha256, "approval envelope hash");
    assertHash(binding.targetDescriptorSha256, "target descriptor hash");
    assertHash(binding.operatorBundleSha256, "operator bundle hash");
  }

  async ensureJournalExists() {
    let handle;
    let created = false;
    try {
      handle = await open(this.journalPath, "ax", 0o600);
      created = true;
      await handle.sync();
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
    if (created) await fsyncDirectory(this.rootPath);
    await this.assertJournalFile();
  }

  async assertJournalFile() {
    const stat = await lstat(this.journalPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("action journal must be a regular file and not a symlink");
    }
    if (this.enforceMode && Number(stat.mode & 0o777n) !== 0o600) {
      throw new Error("action journal must use mode 0600");
    }
    if (this.enforceOwnership && Number(stat.uid) !== this.expectedOwnerUid) {
      throw new Error("action journal has invalid ownership");
    }
    if (stat.size > BigInt(MAX_JOURNAL_BYTES)) throw new Error("action journal exceeds size limit");
    return stat;
  }

  async acquireExclusiveFileLock() {
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new Error("action journal is locked by another controller");
      }
      throw error;
    }
    try {
      const payload = `${canonicalJson({ pid: process.pid, nonce: randomUUID() })}\n`;
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await fsyncDirectory(this.rootPath);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error("action journal lock must be a regular file");
      return { kind: "exclusive-file", handle, stat };
    } catch (error) {
      await handle.close();
      await unlink(this.lockPath).catch(() => undefined);
      await fsyncDirectory(this.rootPath).catch(() => undefined);
      throw error;
    }
  }

  async releaseExclusiveFileLock(lock) {
    await lock.handle.close();
    const current = await lstat(this.lockPath, { bigint: true }).catch(() => null);
    if (!current || !sameIdentity(current, lock.stat)) {
      throw new Error("action journal lock identity changed");
    }
    await unlink(this.lockPath);
    await fsyncDirectory(this.rootPath);
  }

  async openNativeLockFile() {
    const existed = await lstat(this.lockPath).then(
      () => true,
      (error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      },
    );
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(
      this.lockPath,
      constants.O_CREAT | constants.O_RDWR | noFollow,
      0o600,
    );
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error("action journal lock must be a regular file");
      if (this.enforceMode && Number(stat.mode & 0o777n) !== 0o600) {
        throw new Error("action journal lock must use mode 0600");
      }
      if (this.enforceOwnership && Number(stat.uid) !== this.expectedOwnerUid) {
        throw new Error("action journal lock has invalid ownership");
      }
      if (!existed) await fsyncDirectory(this.rootPath);
      return { handle, stat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async acquireNativeFlock() {
    const lockFile = await this.openNativeLockFile();
    const child = spawn(
      "flock",
      ["--exclusive", "--nonblock", "3", "sh", "-c", 'printf "SPX_LOCKED\\n"; IFS= read -r _'],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", lockFile.handle.fd],
      },
    );
    try {
      await new Promise((resolveReady, rejectReady) => {
        let settled = false;
        let output = "";
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          callback(value);
        };
        const timeout = setTimeout(
          () => finish(rejectReady, new Error("native action journal lock acquisition timed out")),
          5_000,
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("SPX_LOCKED\n")) finish(resolveReady);
        });
        child.once("error", (error) => finish(rejectReady, error));
        child.once("exit", (code) => {
          finish(
            rejectReady,
            new Error(
              code === 1
                ? "action journal is locked by another controller"
                : "native action journal lock helper exited before acquisition",
            ),
          );
        });
      });
      return { kind: "native-flock", child, ...lockFile };
    } catch (error) {
      child.kill("SIGKILL");
      await lockFile.handle.close();
      throw error;
    }
  }

  async releaseNativeFlock(lock) {
    const exit = new Promise((resolveExit, rejectExit) => {
      lock.child.once("error", rejectExit);
      lock.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    lock.child.stdin.end("release\n");
    let timeout;
    let result;
    let failure;
    try {
      result = await Promise.race([
        exit,
        new Promise((_, rejectTimeout) => {
          timeout = setTimeout(
            () => rejectTimeout(new Error("native action journal lock release timed out")),
            5_000,
          );
        }),
      ]);
    } catch (error) {
      failure = error;
      lock.child.kill("SIGKILL");
    } finally {
      clearTimeout(timeout);
    }
    const current = await lstat(this.lockPath, { bigint: true }).catch(() => null);
    await lock.handle.close();
    if (failure) throw failure;
    if (!current || !sameIdentity(current, lock.stat)) {
      throw new Error("action journal native lock identity changed");
    }
    if (result.code !== 0 || result.signal) {
      throw new Error("native action journal lock helper failed during release");
    }
  }

  async acquireLock() {
    return this.lockStrategy === "native-flock"
      ? this.acquireNativeFlock()
      : this.acquireExclusiveFileLock();
  }

  async releaseLock(lock) {
    if (lock.kind === "native-flock") return this.releaseNativeFlock(lock);
    return this.releaseExclusiveFileLock(lock);
  }

  async withLock(callback) {
    if (this.closed) throw new Error("action journal is closed");
    const lock = await this.acquireLock();
    let result;
    let failure;
    try {
      result = await callback();
    } catch (error) {
      failure = error;
    }
    try {
      await this.releaseLock(lock);
    } catch (error) {
      if (!failure) failure = error;
    }
    if (failure) throw failure;
    return result;
  }

  validateRecord(record, index, expectedPreviousHash) {
    assertObject(record, `journal record ${index + 1}`);
    assertExactKeys(record, recordFields(record.event), `journal record ${index + 1}`);
    if (record.version !== 1 || record.recordNumber !== index + 1) {
      throw new Error("action journal record sequence is invalid");
    }
    parseTime(record.recordedAt, "recordedAt");
    if (canonicalJson(record.binding) !== canonicalJson(this.binding)) {
      throw new Error("action journal record binding is invalid");
    }
    if (record.previousRecordSha256 !== expectedPreviousHash) {
      throw new Error("action journal hash chain is invalid");
    }
    assertHash(record.recordSha256, "record hash");
    const unsigned = { ...record };
    delete unsigned.recordSha256;
    if (record.recordSha256 !== sha256Canonical(unsigned)) {
      throw new Error("action journal record hash is invalid");
    }
  }

  applyRecord(record) {
    applyJournalRecord(this.actions, this.states, record);
  }

  async reload() {
    const before = await this.assertJournalFile();
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(this.journalPath, constants.O_RDONLY | noFollow);
    let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened) || before.size !== opened.size) {
        throw new Error("action journal changed before validation");
      }
      bytes = await handle.readFile();
      const afterRead = await handle.stat({ bigint: true });
      if (
        !sameIdentity(opened, afterRead) ||
        opened.size !== afterRead.size ||
        BigInt(bytes.byteLength) !== afterRead.size
      ) {
        throw new Error("action journal changed during validation");
      }
    } finally {
      await handle.close();
    }
    const after = await this.assertJournalFile();
    if (!sameIdentity(before, after) || before.size !== after.size) {
      throw new Error("action journal path changed during validation");
    }
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
      throw new Error("action journal contains a truncated record without a newline");
    }
    const lines = bytes.byteLength === 0 ? [] : bytes.toString("utf8").slice(0, -1).split("\n");
    this.records = [];
    this.actions = new Map();
    this.states = new Map();
    let previousHash = ZERO_HASH;
    for (const [index, line] of lines.entries()) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("action journal contains invalid or truncated JSON");
      }
      if (canonicalJson(record) !== line)
        throw new Error("action journal record is not canonical JSON");
      this.validateRecord(record, index, previousHash);
      this.applyRecord(record);
      this.records.push(record);
      previousHash = record.recordSha256;
    }
    this.headHash = previousHash;
  }

  async appendRecord(fields) {
    const base = {
      version: 1,
      recordNumber: this.records.length + 1,
      recordedAt: this.currentDate().toISOString(),
      binding: this.binding,
      ...fields,
      previousRecordSha256: this.headHash,
    };
    const record = { ...base, recordSha256: sha256Canonical(base) };
    const bytes = Buffer.from(`${canonicalJson(record)}\n`);
    const before = await this.assertJournalFile();
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(this.journalPath, constants.O_APPEND | constants.O_WRONLY | noFollow);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened) || before.size !== opened.size) {
        throw new Error("action journal changed before append");
      }
      await handle.writeFile(bytes);
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, after) || after.size !== opened.size + BigInt(bytes.byteLength)) {
        throw new Error("action journal append was not atomic");
      }
    } finally {
      await handle.close();
    }
    this.records.push(record);
    this.applyRecord(record);
    this.headHash = record.recordSha256;
  }

  currentDate() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("action journal clock is invalid");
    return date;
  }

  async validateAction(action, options = {}) {
    assertObject(action, "signed action");
    try {
      await this.verifyAction(action);
    } catch (error) {
      const detail = action.kind === "compensation" ? "signed compensation" : "signed action";
      throw new Error(`${detail} verification failed`, { cause: error });
    }
    const actualBinding = bindingFromAction(action);
    this.validateBinding(actualBinding);
    const bindingLabels = {
      approvalId: "approval",
      stagingRunId: "staging run",
      approvalEnvelopeSha256: "approval envelope",
      targetDescriptorSha256: "target descriptor",
      operatorBundleSha256: "operator bundle",
    };
    for (const field of BINDING_FIELDS) {
      if (actualBinding[field] !== this.binding[field]) {
        throw new Error(`${bindingLabels[field]} binding does not match the journal`);
      }
    }
    if (!Number.isInteger(action.sequence) || action.sequence <= 0) {
      throw new Error("action sequence is invalid");
    }
    assertId(action.actionId, "action ID");
    assertId(action.scope, "action scope");
    if (!["forward", "compensation", "emergency"].includes(action.kind)) {
      throw new Error("action kind is invalid");
    }
    assertHash(action.mutationSha256, "action mutation hash");
    const notBefore = parseTime(action.notBefore, "action notBefore");
    const expiresAt = parseTime(action.expiresAt, "action expiresAt");
    if (expiresAt <= notBefore) throw new Error("action validity window is invalid");
    if (options.enforceTime !== false) {
      const now = this.currentDate().getTime();
      if (now < notBefore) throw new Error("action is not yet valid");
      if (now >= expiresAt) throw new Error("action is expired");
    }
    if (action.kind === "compensation")
      assertId(action.compensatesActionId, "compensated action ID");
    const operation = this.operationRegistry.get(action.actionId);
    if (!operation || typeof operation.execute !== "function") {
      throw new Error("approved action has no fixed controller operation");
    }
    if (sha256Canonical(operation.descriptor) !== action.mutationSha256) {
      throw new Error("fixed controller operation does not match the signed mutation hash");
    }
  }

  async recoverCompletedCompensations() {
    for (const [compensationKey, descriptor] of this.actions) {
      if (descriptor.kind !== "compensation" || this.states.get(compensationKey) !== "succeeded") {
        continue;
      }
      const originalEntry = [...this.actions.entries()].find(
        ([, candidate]) => candidate.actionId === descriptor.compensatesActionId,
      );
      if (!originalEntry) throw new Error("completed compensation target is not registered");
      const [originalKey] = originalEntry;
      if (["failed", "ambiguous"].includes(this.states.get(originalKey))) {
        await this.appendRecord({
          event: "compensated",
          actionKey: originalKey,
          compensationActionKey: compensationKey,
        });
      }
    }
  }

  async runTestHook(name, action) {
    const hook = this.testHooks[name];
    if (typeof hook === "function") await hook(freezeClone(action));
  }

  assertRegisteredActionMatches(action, registered) {
    const expected = persistedAction(action);
    if (action.mutationSha256 !== registered.mutationSha256) {
      throw new Error("action mutation hash does not match its registered approval");
    }
    if (action.scope !== registered.scope) {
      throw new Error("action scope does not match its registered approval");
    }
    if (canonicalJson(expected) !== canonicalJson(registered)) {
      throw new Error("action descriptor does not match its registered approval");
    }
  }

  assertActionCanAdvance(action, key) {
    const state = this.states.get(key);
    if (!state) throw new Error("action scope is not registered by this approval");
    if (state !== "registered") throw new Error(`action was consumed or is a replay (${state})`);
    if (action.kind === "forward") {
      for (const [otherKey, descriptor] of this.actions) {
        if (descriptor.kind !== "forward" || descriptor.sequence >= action.sequence) continue;
        const predecessorState = this.states.get(otherKey);
        if (!["succeeded", "reconciled", "compensated"].includes(predecessorState)) {
          throw new Error("action is out of order because a predecessor is incomplete");
        }
      }
    }
  }

  async consume(action, ...callerArguments) {
    if (callerArguments.length > 0) {
      throw new Error("staging actions execute only through the fixed operation registry");
    }
    if (action.kind === "compensation") {
      throw new Error("compensation actions must use the compensation controller");
    }
    return this.withLock(async () => {
      await this.reload();
      await this.validateAction(action, { enforceTime: true });
      const key = stagingActionKey(action);
      const registered = this.actions.get(key);
      if (!registered) throw new Error("action scope is not registered by this approval");
      this.assertRegisteredActionMatches(action, registered);
      this.assertActionCanAdvance(action, key);
      await this.appendRecord({
        event: "consumed",
        actionKey: key,
        mutationSha256: action.mutationSha256,
      });
      await this.runTestHook("afterConsumed", action);
      const operation = this.operationRegistry.get(action.actionId);
      let result;
      try {
        result = normalizeOperationResult(await operation.execute());
      } catch {
        await this.appendRecord({
          event: "failed",
          actionKey: key,
          errorSha256: sha256Canonical({ code: "staging-action-operation-failed" }),
        });
        throw new Error("staging action operation failed");
      }
      await this.appendRecord({
        event: "succeeded",
        actionKey: key,
        resultSha256: sha256Canonical(result),
      });
      return true;
    });
  }

  async reconcile(action, reconciliation) {
    return this.withLock(async () => {
      await this.reload();
      await this.validateAction(action, { enforceTime: false });
      try {
        await this.verifyReconciliation(reconciliation);
      } catch (error) {
        throw new Error("signed postcondition reconciliation verification failed", {
          cause: error,
        });
      }
      assertObject(reconciliation, "signed reconciliation");
      const reconciliationBinding = bindingFromAction(reconciliation);
      for (const field of BINDING_FIELDS) {
        if (reconciliationBinding[field] !== this.binding[field]) {
          throw new Error("reconciliation binding does not match the journal");
        }
      }
      assertId(reconciliation.reconciliationId, "reconciliation ID");
      if (reconciliation.actionId !== action.actionId || reconciliation.scope !== action.scope) {
        throw new Error("reconciliation does not bind the ambiguous action");
      }
      if (!["succeeded", "failed"].includes(reconciliation.outcome)) {
        throw new Error("reconciliation outcome is invalid");
      }
      assertHash(reconciliation.postconditionSha256, "postcondition hash");
      parseTime(reconciliation.checkedAt, "reconciliation checkedAt");
      const key = stagingActionKey(action);
      const registered = this.actions.get(key);
      if (!registered) throw new Error("reconciled action is not registered");
      this.assertRegisteredActionMatches(action, registered);
      if (this.states.get(key) !== "ambiguous") {
        throw new Error("only an ambiguous action may be reconciled");
      }
      await this.appendRecord({
        event: "reconciled",
        actionKey: key,
        reconciliationId: reconciliation.reconciliationId,
        outcome: reconciliation.outcome,
        postconditionSha256: reconciliation.postconditionSha256,
      });
    });
  }

  async compensate(compensation, ...callerArguments) {
    if (callerArguments.length > 0) {
      throw new Error("staging compensations execute only through the fixed operation registry");
    }
    if (compensation.kind !== "compensation")
      throw new Error("signed compensation action is required");
    return this.withLock(async () => {
      await this.reload();
      await this.validateAction(compensation, { enforceTime: true });
      const compensationKey = stagingActionKey(compensation);
      const registeredCompensation = this.actions.get(compensationKey);
      if (!registeredCompensation) throw new Error("signed compensation is not registered");
      this.assertRegisteredActionMatches(compensation, registeredCompensation);
      this.assertActionCanAdvance(compensation, compensationKey);
      const originalEntry = [...this.actions.entries()].find(
        ([, descriptor]) => descriptor.actionId === compensation.compensatesActionId,
      );
      if (!originalEntry) throw new Error("compensation target action is not registered");
      const [originalKey] = originalEntry;
      if (!["failed", "ambiguous"].includes(this.states.get(originalKey))) {
        throw new Error("compensation target is not failed or ambiguous");
      }
      await this.appendRecord({
        event: "consumed",
        actionKey: compensationKey,
        mutationSha256: compensation.mutationSha256,
      });
      await this.runTestHook("afterConsumed", compensation);
      const operation = this.operationRegistry.get(compensation.actionId);
      let result;
      try {
        result = normalizeOperationResult(await operation.execute());
      } catch {
        await this.appendRecord({
          event: "failed",
          actionKey: compensationKey,
          errorSha256: sha256Canonical({ code: "staging-compensation-operation-failed" }),
        });
        throw new Error("staging compensation operation failed");
      }
      await this.appendRecord({
        event: "succeeded",
        actionKey: compensationKey,
        resultSha256: sha256Canonical(result),
      });
      await this.runTestHook("afterCompensationSucceeded", compensation);
      await this.appendRecord({
        event: "compensated",
        actionKey: originalKey,
        compensationActionKey: compensationKey,
      });
      return true;
    });
  }

  state(key) {
    return this.states.get(key) ?? "unknown";
  }

  async snapshot(...callerArguments) {
    if (callerArguments.length > 0) {
      throw new Error("action journal snapshot accepts zero arguments and no caller-selected filter");
    }
    return this.withLock(async () => {
      await this.reload();
      return freezeClone(
        buildOrderedJournalSnapshot({
          binding: this.binding,
          records: this.records,
          actions: this.actions,
          states: this.states,
          headSha256: this.headHash,
        }),
      );
    });
  }

  async head() {
    return this.withLock(async () => {
      await this.reload();
      return this.headHash;
    });
  }

  async close() {
    this.closed = true;
  }
}

export async function openStagingActionLedger(options = {}) {
  if (!Array.isArray(options.actions) || options.actions.length === 0) {
    throw new Error("verified ordered actions are required");
  }
  const ledger = new StagingActionLedger(options);
  return ledger.initialize(options.actions);
}

async function assertExistingJournalRoot(ledger) {
  const rootRealPath = resolve(await realpath(ledger.rootPath));
  const pathMatches =
    process.platform === "win32"
      ? rootRealPath.toLowerCase() === ledger.rootPath.toLowerCase()
      : rootRealPath === ledger.rootPath;
  if (!pathMatches) throw new Error("action journal root path must not contain a symlink");
  const rootStat = await lstat(ledger.rootPath, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("action journal root must be a regular directory");
  }
  if (ledger.enforceMode && Number(rootStat.mode & 0o777n) !== 0o700) {
    throw new Error("action journal root must use mode 0700");
  }
  if (ledger.enforceOwnership && Number(rootStat.uid) !== ledger.expectedOwnerUid) {
    throw new Error("action journal root has invalid ownership");
  }
  await ledger.assertJournalFile();
}

function authenticatedSnapshotOptions(options) {
  const hasRootPath = Object.hasOwn(options, "rootPath");
  const optionFields = hasRootPath
    ? ["binding", "snapshot", "rootPath"]
    : ["binding", "snapshot"];
  assertExactKeys(options, optionFields, "action journal snapshot prefix options");
  if (hasRootPath && process.env.NODE_ENV !== "test") {
    throw new Error("caller-selected action journal root paths are forbidden in production");
  }
  assertSnapshotShape(options.snapshot);
  return { hasRootPath };
}

async function readAuthenticatedSnapshotPair(options) {
  const { hasRootPath } = authenticatedSnapshotOptions(options);
  const ledger = new StagingActionLedger({
    rootPath: hasRootPath ? options.rootPath : undefined,
    binding: options.binding,
    verifyAction: async () => true,
  });
  ledger.validateBinding(options.binding);
  ledger.validateBinding(options.snapshot.binding);
  if (canonicalJson(options.snapshot.binding) !== canonicalJson(options.binding)) {
    throw new Error("action journal snapshot binding does not match the verified binding");
  }
  await assertExistingJournalRoot(ledger);

  try {
    return await ledger.withLock(async () => {
      await ledger.reload();
      if (options.snapshot.recordCount > ledger.records.length) {
        throw new Error("action journal is truncated before the snapshot prefix");
      }
      const prefixRecords = ledger.records.slice(0, options.snapshot.recordCount);
      const prefixHeadSha256 = prefixRecords.at(-1)?.recordSha256 ?? ZERO_HASH;
      if (prefixHeadSha256 !== options.snapshot.headSha256) {
        throw new Error("action journal snapshot prefix head diverged");
      }
      const prefixProjection = replayJournalRecords(prefixRecords);
      const reconstructed = buildOrderedJournalSnapshot({
        binding: options.binding,
        records: prefixRecords,
        actions: prefixProjection.actions,
        states: prefixProjection.states,
        headSha256: prefixHeadSha256,
      });
      if (canonicalJson(reconstructed) !== canonicalJson(options.snapshot)) {
        throw new Error("action journal snapshot prefix semantic content diverged");
      }

      const current = buildOrderedJournalSnapshot({
        binding: options.binding,
        records: ledger.records,
        actions: ledger.actions,
        states: ledger.states,
        headSha256: ledger.headHash,
      });
      const identityFields = ["sequence", "actionId", "scope", "kind", "mutationSha256"];
      const snapshotIdentities = options.snapshot.actions.map((entry) =>
        Object.fromEntries(identityFields.map((field) => [field, entry[field]])),
      );
      const currentIdentities = current.actions.map((entry) =>
        Object.fromEntries(identityFields.map((field) => [field, entry[field]])),
      );
      if (canonicalJson(snapshotIdentities) !== canonicalJson(currentIdentities)) {
        throw new Error("action journal snapshot signed action sequence changed");
      }
      return freezeClone({ prefixHeadSha256, current });
    });
  } finally {
    await ledger.close();
  }
}

export async function verifyStagingActionJournalSnapshotPrefix(options = {}) {
  const { prefixHeadSha256, current } = await readAuthenticatedSnapshotPair(options);
  return freezeClone({
    ok: true,
    prefixHeadSha256,
    currentHeadSha256: current.headSha256,
  });
}

export async function readAuthenticatedStagingActionJournalSnapshot(options = {}) {
  const { current } = await readAuthenticatedSnapshotPair(options);
  return current;
}

export async function readStagingActionTerminal(options = {}) {
  const action = options.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("the exact signed staging action is required for journal observation");
  }
  const ledger = new StagingActionLedger({
    ...options,
    verifyAction: async () => true,
  });
  ledger.validateBinding(options.binding);

  await assertExistingJournalRoot(ledger);
  await ledger.reload();
  const actionKey = stagingActionKey(action);
  const registered = ledger.actions.get(actionKey);
  if (!registered) throw new Error("required action is not registered in the action journal");
  ledger.assertRegisteredActionMatches(action, registered);
  const state = ledger.states.get(actionKey);
  if (!['succeeded', 'reconciled'].includes(state)) {
    throw new Error("required action has no terminal success in the action journal");
  }
  const terminal = [...ledger.records].reverse().find((record) =>
    record.actionKey === actionKey && (
      record.event === "succeeded" ||
      (record.event === "reconciled" && record.outcome === "succeeded")
    ));
  const finalRecord = ledger.records.at(-1);
  if (!terminal || terminal !== finalRecord || terminal.recordSha256 !== ledger.headHash) {
    throw new Error("required action terminal success is not the current journal head");
  }
  return freezeClone({
    actionId: action.actionId,
    actionKey,
    terminalRecordSha256: terminal.recordSha256,
    journalHeadSha256: ledger.headHash,
  });
}
