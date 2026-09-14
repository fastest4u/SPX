import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";
import {
  openStagingActionLedger,
  readAuthenticatedStagingActionJournalSnapshot,
  readStagingActionTerminal,
  stagingActionKey,
  verifyStagingActionJournalSnapshotPrefix,
} from "../scripts/lib/staging-action-ledger.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import {
  createTestStagingOperationRegistry,
  stagingOperationDescriptor,
} from "../scripts/lib/staging-operation-registry.mjs";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const binding = {
  approvalId: "staging-approval-20260710-001",
  stagingRunId: "staging-run-20260710-001",
  approvalEnvelopeSha256: "a".repeat(64),
  targetDescriptorSha256: "b".repeat(64),
  operatorBundleSha256: "c".repeat(64),
};

function action(
  sequence: number,
  actionId: string,
  scope: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...binding,
    sequence,
    actionId,
    scope,
    kind: "forward",
    mutationSha256: sha256Canonical(operationDescriptor(actionId, scope)),
    notBefore: "2026-07-10T00:00:00.000Z",
    expiresAt: "2026-07-11T00:00:00.000Z",
    signatureVerified: true,
    ...overrides,
  };
}

function operationDescriptor(actionId: string, scope: string) {
  return stagingOperationDescriptor({ actionId, scope });
}

const dbAction = action(1, "staging-db-bootstrap", "database");
const dockerAction = action(2, "staging-compose-start", "docker");
const publishAction = action(3, "staging-controlled-publish", "publish");
const compensationAction = action(4, "staging-publish-compensation", "compensation", {
  kind: "compensation",
  compensatesActionId: publishAction.actionId,
});
const actions = [dbAction, dockerAction, publishAction, compensationAction];
const rolloutActions = REQUIRED_STAGING_ACTION_PLAN.map((entry) =>
  action(entry.sequence, entry.actionId, entry.scope, {
    kind: entry.kind,
    mutationSha256: entry.mutationSha256,
  }),
);
const phase3ActionIds = REQUIRED_STAGING_ACTION_PLAN.slice(15, 23).map(
  (entry) => entry.actionId,
);

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

async function appendCanonicalJournalSuffix(
  rootPath: string,
  fields: Array<Record<string, unknown>>,
): Promise<void> {
  const journalPath = join(rootPath, "actions.jsonl");
  const existing = (await readFile(journalPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  let previousRecordSha256 = existing.at(-1)?.recordSha256 ?? "0".repeat(64);
  let recordNumber = existing.length;
  const suffix = fields.map((entry) => {
    const unsigned = {
      version: 1,
      recordNumber: ++recordNumber,
      recordedAt: NOW.toISOString(),
      binding,
      ...entry,
      previousRecordSha256,
    };
    const record = { ...unsigned, recordSha256: sha256Canonical(unsigned) };
    previousRecordSha256 = record.recordSha256;
    return record;
  });
  await appendFile(
    journalPath,
    `${suffix.map((record) => canonicalJson(record)).join("\n")}\n`,
    "utf8",
  );
}

function verifySignedAction(value: Record<string, unknown>) {
  if (value.signatureVerified !== true) throw new Error("signed action verification failed");
  return true;
}

type OperationBehavior = () => Promise<{ ok: boolean; code: string }>;

async function openLedger(
  rootPath: string,
  actionSet = actions,
  behaviors: Record<string, OperationBehavior> = {},
  testHooks: Record<string, (value: Record<string, unknown>) => Promise<void> | void> = {},
) {
  const operationRegistry = createTestStagingOperationRegistry(actionSet, behaviors);
  return openStagingActionLedger({
    rootPath,
    binding,
    actions: actionSet,
    now: () => NOW,
    verifyAction: verifySignedAction,
    verifyReconciliation: verifySignedAction,
    operationRegistry,
    testHooks,
    enforceOwnership: false,
    enforceMode: process.platform !== "win32",
  });
}

async function main() {
  process.env.NODE_ENV = "test";
  const root = await mkdtemp(join(tmpdir(), "spx-staging-action-ledger-"));
  try {
    let observedConsumedBeforeMutation = false;
    const ledger = await openLedger(
      root,
      actions,
      {
        [dbAction.actionId]: async () => {
          const records = (await readFile(join(root, "actions.jsonl"), "utf8"))
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          observedConsumedBeforeMutation = records.at(-1)?.event === "consumed";
          return { ok: true, code: "database-bootstrap-complete" };
        },
      },
      {
        afterConsumed(value) {
          if (value.actionId === dockerAction.actionId) throw new Error("simulated-process-crash");
        },
      },
    );
    assert.equal(ledger.state(stagingActionKey(dbAction)), "registered");
    assert.equal(ledger.state(stagingActionKey(dockerAction)), "registered");

    let injectedCallbackRan = false;
    await assert.rejects(
      () =>
        ledger.consume(dockerAction, async () => {
          injectedCallbackRan = true;
          return true;
        }),
      /fixed operation registry/i,
    );
    assert.equal(injectedCallbackRan, false);
    await assert.rejects(() => ledger.consume(dockerAction), /out of order/i);

    await ledger.consume(dbAction);
    assert.equal(observedConsumedBeforeMutation, true);
    assert.equal(ledger.state(stagingActionKey(dbAction)), "succeeded");
    const terminal = await readStagingActionTerminal({
      rootPath: root,
      binding,
      action: dbAction,
      enforceOwnership: false,
      enforceMode: process.platform !== "win32",
    });
    assert.equal(terminal.actionId, dbAction.actionId);
    assert.equal(terminal.actionKey, stagingActionKey(dbAction));
    assert.match(terminal.terminalRecordSha256, /^[0-9a-f]{64}$/);
    assert.equal(terminal.journalHeadSha256, terminal.terminalRecordSha256);
    await assert.rejects(
      () => readStagingActionTerminal({
        rootPath: root,
        binding,
        action: dockerAction,
        enforceOwnership: false,
        enforceMode: process.platform !== "win32",
      }),
      /terminal|succeeded|action/i,
    );
    await assert.rejects(() => ledger.consume(dbAction), /consumed|replay/i);

    await assert.rejects(() => ledger.consume(dockerAction), /simulated-process-crash/i);
    assert.equal(ledger.state(stagingActionKey(dockerAction)), "ambiguous");
    await ledger.close();

    const reopened = await openLedger(root, actions, {
      [publishAction.actionId]: async () => {
        throw new Error("sensitive mutation failure at C:\\secret\\path");
      },
      [compensationAction.actionId]: async () => ({
        ok: true,
        code: "publish-compensation-complete",
      }),
    });
    assert.equal(reopened.state(stagingActionKey(dockerAction)), "ambiguous");
    await assert.rejects(() => reopened.consume(dockerAction), /ambiguous|replay/i);
    await reopened.reconcile(dockerAction, {
      ...binding,
      reconciliationId: "reconcile-compose-postcondition-001",
      actionId: dockerAction.actionId,
      scope: dockerAction.scope,
      outcome: "succeeded",
      postconditionSha256: "e".repeat(64),
      checkedAt: "2026-07-10T12:05:00.000Z",
      signatureVerified: true,
    });
    assert.equal(reopened.state(stagingActionKey(dockerAction)), "reconciled");
    const reconciledSnapshot = await reopened.snapshot();
    const reconciledEntry = reconciledSnapshot.actions.find(
      (entry: { actionId: string }) => entry.actionId === dockerAction.actionId,
    );
    assert.deepEqual(reconciledEntry, {
      sequence: dockerAction.sequence,
      actionId: dockerAction.actionId,
      scope: dockerAction.scope,
      kind: dockerAction.kind,
      mutationSha256: dockerAction.mutationSha256,
      state: "reconciled",
      occurrences: 1,
      terminalRecordSha256: reconciledEntry?.terminalRecordSha256,
      completedAt: NOW.toISOString(),
      reconciliationId: "reconcile-compose-postcondition-001",
      reconciliationOutcome: "succeeded",
    });
    assert.match(reconciledEntry?.terminalRecordSha256 ?? "", /^[0-9a-f]{64}$/);
    await assert.rejects(
      () => reopened.snapshot("caller-selected-filter"),
      /argument|filter|zero/i,
    );

    await assert.rejects(
      () => reopened.consume({ ...publishAction, mutationSha256: "f".repeat(64) }),
      /mutation hash/i,
    );
    await assert.rejects(
      () => reopened.consume({ ...publishAction, approvalId: "different-approval" }),
      /approval/i,
    );
    await assert.rejects(
      () => reopened.consume({ ...publishAction, targetDescriptorSha256: "0".repeat(64) }),
      /target descriptor/i,
    );
    await assert.rejects(
      () => reopened.consume({ ...publishAction, operatorBundleSha256: "0".repeat(64) }),
      /operator bundle/i,
    );
    await assert.rejects(
      () => reopened.consume({ ...publishAction, expiresAt: "2026-07-10T11:59:59.000Z" }),
      /expired/i,
    );

    await assert.rejects(() => reopened.consume(publishAction), /staging action operation failed/i);
    assert.equal(reopened.state(stagingActionKey(publishAction)), "failed");
    const failedJournal = await readFile(join(root, "actions.jsonl"), "utf8");
    assert.equal(failedJournal.includes("sensitive mutation failure"), false);
    assert.equal(failedJournal.includes("C:\\secret\\path"), false);
    await assert.rejects(
      () => reopened.compensate({ ...compensationAction, signatureVerified: false }),
      /signed action|signed compensation/i,
    );
    await reopened.compensate(compensationAction);
    assert.equal(reopened.state(stagingActionKey(publishAction)), "compensated");
    assert.equal(reopened.state(stagingActionKey(compensationAction)), "succeeded");
    await reopened.close();

    const replayLedger = await openLedger(root);
    await assert.rejects(() => replayLedger.consume(dbAction), /consumed|replay/i);
    assert.match(await replayLedger.head(), /^[0-9a-f]{64}$/);
    const journal = await readFile(join(root, "actions.jsonl"), "utf8");
    assert.equal(journal.endsWith("\n"), true);
    const journalRecords = journal
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    let previousRecordSha256 = "0".repeat(64);
    journalRecords.forEach((record, index) => {
      assert.equal(record.recordNumber, index + 1);
      assert.equal(record.previousRecordSha256, previousRecordSha256);
      const unsigned = { ...record };
      delete unsigned.recordSha256;
      assert.equal(record.recordSha256, sha256Canonical(unsigned));
      assert.equal(canonicalJson(record), journal.trimEnd().split("\n")[index]);
      previousRecordSha256 = record.recordSha256;
    });
    await replayLedger.close();

    const concurrentRoot = await mkdtemp(join(tmpdir(), "spx-staging-action-concurrent-"));
    try {
      const onlyAction = action(1, "staging-concurrent-action", "database");
      const first = await openLedger(concurrentRoot, [onlyAction], {
        [onlyAction.actionId]: async () => {
          mutationStarted();
          await mutationBlocked;
          return { ok: true, code: "concurrent-operation-complete" };
        },
      });
      const second = await openLedger(concurrentRoot, [onlyAction]);
      let releaseMutation!: () => void;
      const mutationBlocked = new Promise<void>((resolveBlocked) => {
        releaseMutation = resolveBlocked;
      });
      let mutationStarted!: () => void;
      const started = new Promise<void>((resolveStarted) => {
        mutationStarted = resolveStarted;
      });
      const firstConsume = first.consume(onlyAction);
      await started;
      await assert.rejects(() => second.consume(onlyAction), /locked|consumed/i);
      releaseMutation();
      await firstConsume;
      assert.equal(await second.head(), await first.head());
      await first.close();
      await second.close();
    } finally {
      await rm(concurrentRoot, { recursive: true, force: true });
    }

    const snapshotRoot = await mkdtemp(join(tmpdir(), "spx-staging-action-snapshot-"));
    try {
      const first = await openLedger(snapshotRoot, rolloutActions);
      for (const approvedAction of rolloutActions.slice(0, 23)) {
        await first.consume(approvedAction);
      }

      const journalBeforeSnapshot = await readFile(join(snapshotRoot, "actions.jsonl"), "utf8");
      const snapshot = await first.snapshot();
      assert.equal(
        await readFile(join(snapshotRoot, "actions.jsonl"), "utf8"),
        journalBeforeSnapshot,
      );
      const journalRecords = journalBeforeSnapshot
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(Object.keys(snapshot), [
        "schemaVersion",
        "binding",
        "recordCount",
        "headSha256",
        "actions",
      ]);
      assert.deepEqual(Object.keys(snapshot.binding), [
        "approvalId",
        "stagingRunId",
        "approvalEnvelopeSha256",
        "targetDescriptorSha256",
        "operatorBundleSha256",
      ]);
      assert.equal(snapshot.schemaVersion, 1);
      assert.deepEqual(snapshot.binding, binding);
      assert.equal(snapshot.recordCount, journalRecords.length);
      assert.equal(snapshot.headSha256, journalRecords.at(-1)?.recordSha256);
      assert.equal(snapshot.actions.length, 44);
      assert.deepEqual(
        snapshot.actions.map((entry: { sequence: number }) => entry.sequence),
        Array.from({ length: 44 }, (_, index) => index + 1),
      );

      const phase3Entries = snapshot.actions.slice(15, 23);
      assert.deepEqual(
        phase3Entries.map((entry: { actionId: string }) => entry.actionId),
        phase3ActionIds,
      );
      for (const entry of phase3Entries) {
        const approvedAction = rolloutActions[entry.sequence - 1];
        const actionKey = stagingActionKey(approvedAction);
        const terminalRecord = journalRecords.find(
          (record) => record.event === "succeeded" && record.actionKey === actionKey,
        );
        assert.deepEqual(Object.keys(entry), [
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
        ]);
        assert.equal(entry.state, "succeeded");
        assert.equal(entry.occurrences, 1);
        assert.equal(entry.terminalRecordSha256, terminalRecord?.recordSha256);
        assert.equal(entry.completedAt, terminalRecord?.recordedAt);
        assert.equal(entry.reconciliationId, null);
        assert.equal(entry.reconciliationOutcome, null);
      }
      assert.deepEqual(snapshot.actions[23], {
        sequence: 24,
        actionId: "staging-gate-4-phase3",
        scope: "gate-4",
        kind: "forward",
        mutationSha256: rolloutActions[23].mutationSha256,
        state: "registered",
        occurrences: 0,
        terminalRecordSha256: null,
        completedAt: null,
        reconciliationId: null,
        reconciliationOutcome: null,
      });
      const serializedSnapshot = canonicalJson(snapshot);
      for (const forbidden of [
        "notBefore",
        "expiresAt",
        "resultSha256",
        "errorSha256",
        "postconditionSha256",
        "operation",
        "payload",
        "credential",
        "secret",
      ]) {
        assert.equal(serializedSnapshot.includes(forbidden), false);
      }
      assertDeepFrozen(snapshot);
      assert.equal(Reflect.set(snapshot.binding, "approvalId", "mutated-approval"), false);
      assert.throws(() => {
        (snapshot.actions as unknown[]).push({});
      }, TypeError);
      assert.deepEqual(snapshot.binding, binding);

      const gate4Action = rolloutActions[23];
      const gate4ActionKey = stagingActionKey(gate4Action);
      const phase3TerminalActionKey = stagingActionKey(rolloutActions[22]);
      const validConsumed = {
        event: "consumed",
        actionKey: gate4ActionKey,
        mutationSha256: gate4Action.mutationSha256,
      };
      const validResultSha256 = sha256Canonical({ ok: true, code: "operation-complete" });
      const validErrorSha256 = sha256Canonical({ code: "staging-action-operation-failed" });
      const validPostconditionSha256 = "e".repeat(64);
      async function assertForgedSuffixRejected(
        label: string,
        suffix: Array<Record<string, unknown>>,
        expected: RegExp,
      ): Promise<void> {
        const forgedRoot = await mkdtemp(join(tmpdir(), `spx-staging-${label}-`));
        try {
          if (process.platform !== "win32") await chmod(forgedRoot, 0o700);
          const forgedJournalPath = join(forgedRoot, "actions.jsonl");
          await writeFile(forgedJournalPath, journalBeforeSnapshot, { mode: 0o600 });
          if (process.platform !== "win32") await chmod(forgedJournalPath, 0o600);
          assert.deepEqual(
            await verifyStagingActionJournalSnapshotPrefix({
              binding,
              snapshot,
              rootPath: forgedRoot,
            }),
            {
              ok: true,
              prefixHeadSha256: snapshot.headSha256,
              currentHeadSha256: snapshot.headSha256,
            },
          );
          await appendCanonicalJournalSuffix(forgedRoot, suffix);
          await assert.rejects(
            () =>
              verifyStagingActionJournalSnapshotPrefix({
                binding,
                snapshot,
                rootPath: forgedRoot,
              }),
            expected,
            label,
          );
        } finally {
          await rm(forgedRoot, { recursive: true, force: true });
        }
      }

      await assertForgedSuffixRejected(
        "forged-consumed-mutation",
        [
          { ...validConsumed, mutationSha256: "0".repeat(64) },
          {
            event: "succeeded",
            actionKey: gate4ActionKey,
            resultSha256: validResultSha256,
          },
        ],
        /mutation/i,
      );
      await assertForgedSuffixRejected(
        "forged-succeeded-result",
        [
          validConsumed,
          {
            event: "succeeded",
            actionKey: gate4ActionKey,
            resultSha256: "invalid-result-hash",
          },
        ],
        /result|hash/i,
      );
      await assertForgedSuffixRejected(
        "forged-failed-error",
        [
          validConsumed,
          {
            event: "failed",
            actionKey: gate4ActionKey,
            errorSha256: "invalid-error-hash",
          },
        ],
        /error|hash/i,
      );
      await assertForgedSuffixRejected(
        "forged-reconciliation-id",
        [
          validConsumed,
          {
            event: "reconciled",
            actionKey: gate4ActionKey,
            reconciliationId: "",
            outcome: "succeeded",
            postconditionSha256: validPostconditionSha256,
          },
        ],
        /reconciliation/i,
      );
      await assertForgedSuffixRejected(
        "forged-reconciliation-outcome",
        [
          validConsumed,
          {
            event: "reconciled",
            actionKey: gate4ActionKey,
            reconciliationId: "reconcile-gate4-001",
            outcome: "unknown",
            postconditionSha256: validPostconditionSha256,
          },
        ],
        /outcome|reconciliation/i,
      );
      await assertForgedSuffixRejected(
        "forged-reconciliation-postcondition",
        [
          validConsumed,
          {
            event: "reconciled",
            actionKey: gate4ActionKey,
            reconciliationId: "reconcile-gate4-001",
            outcome: "succeeded",
            postconditionSha256: "invalid-postcondition-hash",
          },
        ],
        /postcondition|hash/i,
      );
      await assertForgedSuffixRejected(
        "forged-compensation-relation",
        [
          validConsumed,
          {
            event: "failed",
            actionKey: gate4ActionKey,
            errorSha256: validErrorSha256,
          },
          {
            event: "compensated",
            actionKey: gate4ActionKey,
            compensationActionKey: phase3TerminalActionKey,
          },
        ],
        /compensation/i,
      );

      const second = await openLedger(snapshotRoot, rolloutActions);
      const originalReload = first.reload.bind(first);
      let announceSnapshotLock!: () => void;
      const snapshotLockAcquired = new Promise<void>((resolveLocked) => {
        announceSnapshotLock = resolveLocked;
      });
      let releaseSnapshot!: () => void;
      const holdSnapshot = new Promise<void>((resolveHeld) => {
        releaseSnapshot = resolveHeld;
      });
      first.reload = async () => {
        await originalReload();
        announceSnapshotLock();
        await holdSnapshot;
      };
      const competingSnapshot = first.snapshot();
      await snapshotLockAcquired;
      await assert.rejects(() => second.snapshot(), /locked/i);
      releaseSnapshot();
      assert.deepEqual(await competingSnapshot, snapshot);
      first.reload = originalReload;
      assert.deepEqual(await second.snapshot(), snapshot);

      await second.consume(rolloutActions[23]);
      const currentHeadSha256 = await second.head();
      const currentSnapshot = await readAuthenticatedStagingActionJournalSnapshot({
        binding,
        snapshot,
        rootPath: snapshotRoot,
      });
      assert.equal(currentSnapshot.headSha256, currentHeadSha256);
      assert.equal(currentSnapshot.actions[23].actionId, "staging-gate-4-phase3");
      assert.equal(currentSnapshot.actions[23].state, "succeeded");
      assert.equal(currentSnapshot.actions[24].state, "registered");
      assertDeepFrozen(currentSnapshot);
      assert.deepEqual(
        await verifyStagingActionJournalSnapshotPrefix({
          binding,
          snapshot,
          rootPath: snapshotRoot,
        }),
        {
          ok: true,
          prefixHeadSha256: snapshot.headSha256,
          currentHeadSha256,
        },
      );

      const divergentSnapshot = structuredClone(snapshot);
      divergentSnapshot.actions[15].state = "registered";
      await assert.rejects(
        () =>
          verifyStagingActionJournalSnapshotPrefix({
            binding,
            snapshot: divergentSnapshot,
            rootPath: snapshotRoot,
          }),
        /snapshot|prefix|semantic/i,
      );
      const truncatedSnapshot = structuredClone(snapshot);
      truncatedSnapshot.recordCount -= 1;
      await assert.rejects(
        () =>
          verifyStagingActionJournalSnapshotPrefix({
            binding,
            snapshot: truncatedSnapshot,
            rootPath: snapshotRoot,
          }),
        /snapshot|prefix|head|truncat/i,
      );
      await assert.rejects(
        () =>
          verifyStagingActionJournalSnapshotPrefix({
            binding: { ...binding, stagingRunId: "different-staging-run" },
            snapshot,
            rootPath: snapshotRoot,
          }),
        /binding|staging run/i,
      );
      await assert.rejects(
        () =>
          verifyStagingActionJournalSnapshotPrefix({
            binding,
            snapshot,
            rootPath: snapshotRoot,
            recordCount: snapshot.recordCount,
          }),
        /field|count|caller/i,
      );
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await assert.rejects(
          () =>
            verifyStagingActionJournalSnapshotPrefix({
              binding,
              snapshot,
              rootPath: snapshotRoot,
            }),
          /caller-selected|root path|production/i,
        );
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
      await first.close();
      await second.close();
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true });
    }

    const compensationPrefixRoot = await mkdtemp(
      join(tmpdir(), "spx-staging-compensation-prefix-"),
    );
    try {
      const compensationPrefixLedger = await openLedger(compensationPrefixRoot, actions, {
        [publishAction.actionId]: async () => {
          throw new Error("expected-test-operation-failure");
        },
      });
      await compensationPrefixLedger.consume(dbAction);
      await compensationPrefixLedger.consume(dockerAction);
      await assert.rejects(
        () => compensationPrefixLedger.consume(publishAction),
        /staging action operation failed/i,
      );
      const compensationPrefix = await compensationPrefixLedger.snapshot();
      await compensationPrefixLedger.close();
      assert.deepEqual(
        await verifyStagingActionJournalSnapshotPrefix({
          binding,
          snapshot: compensationPrefix,
          rootPath: compensationPrefixRoot,
        }),
        {
          ok: true,
          prefixHeadSha256: compensationPrefix.headSha256,
          currentHeadSha256: compensationPrefix.headSha256,
        },
      );
      await appendCanonicalJournalSuffix(compensationPrefixRoot, [
        {
          event: "compensated",
          actionKey: stagingActionKey(publishAction),
          compensationActionKey: stagingActionKey(compensationAction),
        },
      ]);
      await assert.rejects(
        () =>
          verifyStagingActionJournalSnapshotPrefix({
            binding,
            snapshot: compensationPrefix,
            rootPath: compensationPrefixRoot,
          }),
        /compensation.*terminal|terminal.*compensation|success/i,
      );
    } finally {
      await rm(compensationPrefixRoot, { recursive: true, force: true });
    }

    const truncatedRoot = await mkdtemp(join(tmpdir(), "spx-staging-action-truncated-"));
    try {
      const truncated = await openLedger(truncatedRoot, [dbAction]);
      await truncated.close();
      await appendFile(join(truncatedRoot, "actions.jsonl"), '{"truncated":true}', "utf8");
      await assert.rejects(() => openLedger(truncatedRoot, [dbAction]), /truncated|newline/i);
    } finally {
      await rm(truncatedRoot, { recursive: true, force: true });
    }

    const sequenceRoot = await mkdtemp(join(tmpdir(), "spx-staging-action-sequence-"));
    try {
      await assert.rejects(
        () =>
          openLedger(sequenceRoot, [
            action(1, "staging-sequence-one", "database"),
            action(3, "staging-sequence-three", "docker"),
          ]),
        /contiguous|sequence/i,
      );
    } finally {
      await rm(sequenceRoot, { recursive: true, force: true });
    }

    const failedReconciliationRoot = await mkdtemp(
      join(tmpdir(), "spx-staging-action-reconciliation-"),
    );
    try {
      const firstAction = action(1, "staging-reconcile-one", "database");
      const nextAction = action(2, "staging-reconcile-two", "docker");
      const reconciliationLedger = await openLedger(
        failedReconciliationRoot,
        [firstAction, nextAction],
        {},
        {
          afterConsumed(value) {
            if (value.actionId === firstAction.actionId) throw new Error("simulated-process-crash");
          },
        },
      );
      await assert.rejects(
        () => reconciliationLedger.consume(firstAction),
        /simulated-process-crash/i,
      );
      await reconciliationLedger.reconcile(firstAction, {
        ...binding,
        reconciliationId: "reconcile-failed-postcondition-001",
        actionId: firstAction.actionId,
        scope: firstAction.scope,
        outcome: "failed",
        postconditionSha256: "f".repeat(64),
        checkedAt: "2026-07-10T12:05:00.000Z",
        signatureVerified: true,
      });
      assert.equal(reconciliationLedger.state(stagingActionKey(firstAction)), "failed");
      await assert.rejects(
        () => reconciliationLedger.consume(nextAction),
        /out of order|predecessor/i,
      );
      await reconciliationLedger.close();
    } finally {
      await rm(failedReconciliationRoot, { recursive: true, force: true });
    }

    const compensationCrashRoot = await mkdtemp(join(tmpdir(), "spx-staging-compensation-crash-"));
    try {
      const failedAction = action(1, "staging-crash-target", "publish");
      const recoveryAction = action(2, "staging-crash-compensation", "compensation", {
        kind: "compensation",
        compensatesActionId: failedAction.actionId,
      });
      const crashActions = [failedAction, recoveryAction];
      const crashLedger = await openLedger(
        compensationCrashRoot,
        crashActions,
        {
          [failedAction.actionId]: async () => {
            throw new Error("private target failure");
          },
          [recoveryAction.actionId]: async () => ({
            ok: true,
            code: "compensation-applied",
          }),
        },
        {
          afterCompensationSucceeded() {
            throw new Error("simulated-compensation-marker-crash");
          },
        },
      );
      await assert.rejects(
        () => crashLedger.consume(failedAction),
        /staging action operation failed/i,
      );
      await assert.rejects(
        () => crashLedger.compensate(recoveryAction),
        /simulated-compensation-marker-crash/i,
      );
      assert.equal(crashLedger.state(stagingActionKey(failedAction)), "failed");
      assert.equal(crashLedger.state(stagingActionKey(recoveryAction)), "succeeded");
      await crashLedger.close();

      const recoveredLedger = await openLedger(compensationCrashRoot, crashActions);
      assert.equal(recoveredLedger.state(stagingActionKey(failedAction)), "compensated");
      assert.equal(recoveredLedger.state(stagingActionKey(recoveryAction)), "succeeded");
      const recoveredJournal = (
        await readFile(join(compensationCrashRoot, "actions.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const compensationKey = stagingActionKey(recoveryAction);
      assert.equal(
        recoveredJournal.some(
          (record) => record.event === "failed" && record.actionKey === compensationKey,
        ),
        false,
      );
      assert.equal(
        recoveredJournal.filter(
          (record) =>
            record.event === "compensated" && record.compensationActionKey === compensationKey,
        ).length,
        1,
      );
      await recoveredLedger.close();
    } finally {
      await rm(compensationCrashRoot, { recursive: true, force: true });
    }

    if (process.platform !== "win32") {
      const modeRoot = await mkdtemp(join(tmpdir(), "spx-staging-action-mode-"));
      try {
        const modeLedger = await openLedger(modeRoot, [dbAction]);
        await modeLedger.close();
        await chmod(modeRoot, 0o755);
        await assert.rejects(() => openLedger(modeRoot, [dbAction]), /root.*mode 0700/i);
        await chmod(modeRoot, 0o700);
        await chmod(join(modeRoot, "actions.jsonl"), 0o644);
        await assert.rejects(() => openLedger(modeRoot, [dbAction]), /mode 0600/i);
      } finally {
        await rm(modeRoot, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
