import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACCEPTED_EVIDENCE_EXPORT_ROOT,
  ACCEPTED_EVIDENCE_PATHS,
  exportAcceptedSemanticEvidence,
  parseAcceptedEvidenceCliArgs,
} from "../scripts/gate6-accepted-evidence-export.mjs";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import {
  buildGate6SemanticReceipt,
  semanticReceiptPathForScope,
  writeGate6SemanticReceipt,
} from "../scripts/lib/gate6-semantic-receipt.mjs";

const H = (value: string): string => createHash("sha256").update(value).digest("hex");
const CANDIDATE_SHA = "a".repeat(40);
const NOW = new Date("2026-07-16T01:00:00.000Z");
const LEASE_EXPIRY = "2026-07-16T01:05:00.000Z";

const PHASE = Object.freeze({
  "db-transition": Object.freeze({
    scope: "stage-accept-db-transition",
    actionId: "accept-db-transition-001",
    expectedStage: "admitted",
    nextStage: "db-transition-stable",
    checkerName: "db-transition-production-evidence",
    filename: "accepted-db-transition-evidence.json",
  }),
  "pre-close": Object.freeze({
    scope: "stage-accept-pre-close",
    actionId: "accept-pre-close-001",
    expectedStage: "final-baseline-stable",
    nextStage: "pre-close-accepted",
    checkerName: "pre-close-production-evidence",
    filename: "accepted-pre-close-evidence.json",
  }),
});

const PRIOR_PRE_CLOSE_SCOPES = [
  "stage-accept-db-transition",
  "stage-accept-task9",
  "stage-accept-worker",
  "stage-accept-phase3",
  "stage-accept-phase4",
] as const;

type Phase = keyof typeof PHASE;

const producer = () => ({
  repository: "fastest4u/SPX",
  environment: "production",
  workflow: ".github/workflows/gate6-accepted-evidence-exporter.yml",
  workflowSha: "b".repeat(40),
  workflowFileSha256: H("accepted-evidence-workflow"),
});

function receiptFor(phase: Phase, overrides: Record<string, unknown> = {}) {
  const descriptor = PHASE[phase];
  const checkerOutput = { ok: true, phase, failureCode: null };
  return buildGate6SemanticReceipt({
    gate6Id: "gate6-prod-001",
    scope: descriptor.scope,
    actionId: descriptor.actionId,
    expectedStage: descriptor.expectedStage,
    nextStage: descriptor.nextStage,
    checkerName: descriptor.checkerName,
    checkerExecutableSha256: H(`${phase}:executable`),
    checkerArgumentsSha256: H(`${phase}:arguments`),
    checkerOutputSha256: H(canonicalJson(checkerOutput)),
    checkerOutput,
    checkedAt: "2026-07-16T00:59:00.000Z",
    ...overrides,
  } as Parameters<typeof buildGate6SemanticReceipt>[0]);
}

function bindingFor(
  receipt: ReturnType<typeof receiptFor>,
  overrides: Record<string, unknown> = {},
) {
  return {
    actionStatus: "succeeded",
    afterEvidenceSha256: receipt.acceptedCheckerSha256,
    runStatus: "active",
    currentStage: receipt.nextStage,
    acceptedCheckerName: receipt.checkerName,
    acceptedCheckerSha256: receipt.acceptedCheckerSha256,
    slotOwnerType: "gate6",
    slotOwnerId: receipt.gate6Id,
    slotState: "active",
    slotVersion: 8,
    monitorStatus: "green",
    monitorLeaseExpiresAt: LEASE_EXPIRY,
    supervisorStatus: "green",
    supervisorLeaseExpiresAt: LEASE_EXPIRY,
    ...overrides,
  };
}

async function replaceReceipt(
  receiptRoot: string,
  receipt: ReturnType<typeof receiptFor>,
): Promise<void> {
  const path = semanticReceiptPathForScope(receipt.scope, receiptRoot);
  await chmod(path, 0o600).catch(() => undefined);
  await unlink(path);
  await writeFile(path, canonicalJson(receipt), { flag: "wx", mode: 0o400 });
}

async function fixture(phase: Phase) {
  const root = await mkdtemp(join(tmpdir(), "spx-accepted-evidence-"));
  const receiptRoot = join(root, "receipts");
  const exportRoot = join(root, "export");
  await mkdir(receiptRoot, { mode: 0o700 });
  await mkdir(exportRoot, { mode: 0o700 });
  const receipt = receiptFor(phase);
  if (phase === "pre-close") {
    for (const [index, scope] of PRIOR_PRE_CLOSE_SCOPES.entries()) {
      const checkerOutput = { ok: true, scope, failureCode: null };
      await writeGate6SemanticReceipt(
        buildGate6SemanticReceipt({
          gate6Id: receipt.gate6Id,
          scope,
          actionId: `prior-accept-${index + 1}`,
          expectedStage: "prior-stage",
          nextStage: "accepted-stage",
          checkerName: `prior-checker-${index + 1}`,
          checkerExecutableSha256: H(`${scope}:executable`),
          checkerArgumentsSha256: H(`${scope}:arguments`),
          checkerOutputSha256: H(canonicalJson(checkerOutput)),
          checkerOutput,
          checkedAt: "2026-07-16T00:58:00.000Z",
        }),
        { root: receiptRoot },
      );
    }
  }
  await writeGate6SemanticReceipt(receipt, { root: receiptRoot });
  let binding = bindingFor(receipt);
  let safety = {
    gate6Id: receipt.gate6Id,
    candidateSha: CANDIDATE_SHA,
    activePermitCount: 0,
    uncompensatedWork: 0,
  };
  const calls: unknown[][] = [];
  let duringAcceptedRead: (() => Promise<void>) | undefined;
  const ledger = {
    async getAcceptedSemanticBinding(...args: unknown[]) {
      calls.push(["accepted", ...args]);
      const callback = duringAcceptedRead;
      duringAcceptedRead = undefined;
      await callback?.();
      return structuredClone(binding);
    },
    async getAcceptedSemanticSafetyBinding(...args: unknown[]) {
      calls.push(["safety", ...args]);
      return structuredClone(safety);
    },
  };
  const context = {
    candidateSha: CANDIDATE_SHA,
    ledger,
    now: NOW,
    producer: producer(),
    receiptRoot,
    exportRoot,
  };
  return {
    root,
    receiptRoot,
    exportRoot,
    receipt,
    calls,
    context,
    setBinding(value: ReturnType<typeof bindingFor>) {
      binding = value;
    },
    setSafety(value: typeof safety) {
      safety = value;
    },
    replaceDuringAcceptedRead(callback: () => Promise<void>) {
      duringAcceptedRead = callback;
    },
    async cleanup() {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("exports accepted db-transition evidence bound to the exact durable receipt and ledger state", async () => {
  const f = await fixture("db-transition");
  try {
    const exported = await exportAcceptedSemanticEvidence("db-transition", f.context);
    assert.equal(exported.phase, "db-transition");
    assert.equal(exported.currentStage, "db-transition-stable");
    assert.equal(exported.acceptedCheckerSha256, f.receipt.acceptedCheckerSha256);
    assert.equal(exported.afterEvidenceSha256, f.receipt.acceptedCheckerSha256);
    assert.equal(exported.preCloseSafety, null);
    assert.deepEqual(Object.keys(exported.producer).sort(), [
      "environment",
      "repository",
      "workflow",
      "workflowFileSha256",
      "workflowSha",
    ]);
    assert.deepEqual(f.calls, [
      ["accepted", f.receipt.gate6Id, f.receipt.scope, f.receipt.actionId],
      ["accepted", f.receipt.gate6Id, f.receipt.scope, f.receipt.actionId],
    ]);

    const path = join(f.exportRoot, PHASE["db-transition"].filename);
    const bytes = await readFile(path);
    assert.equal(bytes.toString("utf8"), canonicalJson(exported));
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o400);
    assert.deepEqual(await readdir(f.exportRoot), [PHASE["db-transition"].filename]);
  } finally {
    await f.cleanup();
  }
});

test("exports pre-close only with zero active permits and zero uncompensated work", async () => {
  const f = await fixture("pre-close");
  try {
    const exported = await exportAcceptedSemanticEvidence("pre-close", f.context);
    assert.equal(exported.phase, "pre-close");
    assert.equal(exported.currentStage, "pre-close-accepted");
    assert.deepEqual(exported.preCloseSafety, {
      activePermitCount: 0,
      uncompensatedWork: 0,
    });
    assert.deepEqual(f.calls, [
      ["accepted", f.receipt.gate6Id, f.receipt.scope, f.receipt.actionId],
      ["safety", f.receipt.gate6Id],
      ["accepted", f.receipt.gate6Id, f.receipt.scope, f.receipt.actionId],
      ["safety", f.receipt.gate6Id],
    ]);
    assert.deepEqual(
      (await readdir(f.receiptRoot)).sort(),
      [...PRIOR_PRE_CLOSE_SCOPES, "stage-accept-pre-close"].map((scope) => `${scope}.json`).sort(),
    );
  } finally {
    await f.cleanup();
  }
});

test("rejects wrong ledger stage, state, lease, action, checker, and pre-close safety", async (t) => {
  const cases: Array<[string, Phase, (f: Awaited<ReturnType<typeof fixture>>) => void, RegExp]> = [
    [
      "earlier stage",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { currentStage: "admitted" })),
      /stage/i,
    ],
    [
      "later stage",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { currentStage: "task9-accepted" })),
      /stage/i,
    ],
    [
      "failed action",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { actionStatus: "failed" })),
      /action/i,
    ],
    [
      "revoked run",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { runStatus: "revoked" })),
      /run/i,
    ],
    [
      "slot owner",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { slotOwnerId: "another-gate" })),
      /slot|owner/i,
    ],
    [
      "slot state",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { slotState: "sealed-verifying" })),
      /slot|active/i,
    ],
    [
      "monitor red",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { monitorStatus: "red" })),
      /monitor|green/i,
    ],
    [
      "monitor stale",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { monitorLeaseExpiresAt: NOW.toISOString() })),
      /monitor|lease/i,
    ],
    [
      "supervisor stale",
      "db-transition",
      (f) =>
        f.setBinding(
          bindingFor(f.receipt, { supervisorLeaseExpiresAt: "2026-07-16T00:59:59.999Z" }),
        ),
      /supervisor|lease/i,
    ],
    [
      "checker name",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { acceptedCheckerName: "another-checker" })),
      /checker/i,
    ],
    [
      "checker hash",
      "db-transition",
      (f) => f.setBinding(bindingFor(f.receipt, { acceptedCheckerSha256: H("wrong-checker") })),
      /checker/i,
    ],
    [
      "action evidence",
      "db-transition",
      (f) =>
        f.setBinding(bindingFor(f.receipt, { afterEvidenceSha256: H("wrong-action-evidence") })),
      /evidence|checker/i,
    ],
    [
      "active permit",
      "pre-close",
      (f) =>
        f.setSafety({
          gate6Id: f.receipt.gate6Id,
          candidateSha: CANDIDATE_SHA,
          activePermitCount: 1,
          uncompensatedWork: 0,
        }),
      /permit/i,
    ],
    [
      "uncompensated",
      "pre-close",
      (f) =>
        f.setSafety({
          gate6Id: f.receipt.gate6Id,
          candidateSha: CANDIDATE_SHA,
          activePermitCount: 0,
          uncompensatedWork: 1,
        }),
      /uncompensated/i,
    ],
  ];
  for (const [name, phase, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const f = await fixture(phase);
      try {
        mutate(f);
        await assert.rejects(() => exportAcceptedSemanticEvidence(phase, f.context), pattern);
        assert.deepEqual(await readdir(f.exportRoot), []);
      } finally {
        await f.cleanup();
      }
    });
  }
});

test("rejects receipt phase/hash substitution, replacement, and unsafe receipt-root entries", async (t) => {
  await t.test("checker executable substitution", async () => {
    const f = await fixture("db-transition");
    try {
      await replaceReceipt(
        f.receiptRoot,
        receiptFor("db-transition", {
          checkerExecutableSha256: H("substituted-executable"),
        }),
      );
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /checker|evidence|receipt/i,
      );
    } finally {
      await f.cleanup();
    }
  });

  await t.test("receipt replacement during ledger read", async () => {
    const f = await fixture("db-transition");
    try {
      f.replaceDuringAcceptedRead(async () => {
        await replaceReceipt(
          f.receiptRoot,
          receiptFor("db-transition", {
            checkedAt: "2026-07-16T00:59:01.000Z",
          }),
        );
      });
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /changed|replaced|receipt/i,
      );
    } finally {
      await f.cleanup();
    }
  });

  await t.test("same-byte receipt replacement during ledger read", async () => {
    const f = await fixture("db-transition");
    try {
      f.replaceDuringAcceptedRead(async () => {
        await replaceReceipt(f.receiptRoot, f.receipt);
      });
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /changed|replaced|receipt/i,
      );
    } finally {
      await f.cleanup();
    }
  });

  await t.test("pre-close missing a prior durable receipt", async () => {
    const f = await fixture("pre-close");
    try {
      const missing = semanticReceiptPathForScope(PRIOR_PRE_CLOSE_SCOPES[0], f.receiptRoot);
      await chmod(missing, 0o600).catch(() => undefined);
      await unlink(missing);
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("pre-close", f.context),
        /missing|receipt.*set|exact/i,
      );
      assert.equal(f.calls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  await t.test("unknown extra receipt", async () => {
    const f = await fixture("db-transition");
    try {
      await writeFile(join(f.receiptRoot, "caller-selected.json"), "{}", { mode: 0o400 });
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /receipt.*file|unexpected|extra/i,
      );
      assert.equal(f.calls.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  await t.test("nested receipt entry", async () => {
    const f = await fixture("db-transition");
    try {
      await mkdir(join(f.receiptRoot, "nested"), { mode: 0o700 });
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /receipt.*entry|nested|regular/i,
      );
    } finally {
      await f.cleanup();
    }
  });

  await t.test("symlinked target receipt", async (t2) => {
    const f = await fixture("db-transition");
    try {
      const target = semanticReceiptPathForScope(f.receipt.scope, f.receiptRoot);
      const outside = join(f.root, "outside.json");
      await writeFile(outside, canonicalJson(f.receipt), { mode: 0o400 });
      await chmod(target, 0o600).catch(() => undefined);
      await unlink(target);
      try {
        await symlink(outside, target, "file");
      } catch (error: unknown) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException)?.code === "EPERM") {
          t2.skip("Windows symlink creation is unavailable");
          return;
        }
        throw error;
      }
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /symlink|regular.*receipt|receipt.*entry/i,
      );
    } finally {
      await f.cleanup();
    }
  });
});

test("persists idempotently but rejects conflicting, extra, nested, or symlinked export files", async (t) => {
  await t.test("idempotent identical bytes", async () => {
    const f = await fixture("db-transition");
    try {
      const first = await exportAcceptedSemanticEvidence("db-transition", f.context);
      const second = await exportAcceptedSemanticEvidence("db-transition", f.context);
      assert.deepEqual(second, first);
    } finally {
      await f.cleanup();
    }
  });

  await t.test("idempotent retry tolerates a monotonic lease renewal", async () => {
    const f = await fixture("db-transition");
    try {
      const first = await exportAcceptedSemanticEvidence("db-transition", f.context);
      f.setBinding(
        bindingFor(f.receipt, {
          slotVersion: 9,
          monitorLeaseExpiresAt: "2026-07-16T01:06:00.000Z",
          supervisorLeaseExpiresAt: "2026-07-16T01:06:00.000Z",
        }),
      );
      const second = await exportAcceptedSemanticEvidence("db-transition", f.context);
      assert.deepEqual(second, first);
      assert.equal(second.slotVersion, 8);
    } finally {
      await f.cleanup();
    }
  });

  await t.test("conflicting bytes", async () => {
    const f = await fixture("db-transition");
    try {
      await exportAcceptedSemanticEvidence("db-transition", f.context);
      f.context.producer = { ...producer(), workflowSha: "c".repeat(40) };
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /conflict|bytes/i,
      );
    } finally {
      await f.cleanup();
    }
  });

  for (const [name, create, pattern] of [
    [
      "extra file",
      (f: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(join(f.exportRoot, "unexpected.json"), "{}", { mode: 0o400 }),
      /extra|unexpected|file set/i,
    ],
    [
      "nested directory",
      (f: Awaited<ReturnType<typeof fixture>>) =>
        mkdir(join(f.exportRoot, "nested"), { mode: 0o700 }),
      /nested|regular|entry/i,
    ],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture("db-transition");
      try {
        await create(f);
        await assert.rejects(
          () => exportAcceptedSemanticEvidence("db-transition", f.context),
          pattern,
        );
        assert.equal(f.calls.length, 0);
      } finally {
        await f.cleanup();
      }
    });
  }

  await t.test("symlinked export target", async (t2) => {
    const f = await fixture("db-transition");
    try {
      const outside = join(f.root, "outside.json");
      await writeFile(outside, "{}", { mode: 0o400 });
      const target = join(f.exportRoot, PHASE["db-transition"].filename);
      try {
        await symlink(outside, target, "file");
      } catch (error: unknown) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException)?.code === "EPERM") {
          t2.skip("Windows symlink creation is unavailable");
          return;
        }
        throw error;
      }
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /symlink|regular|entry/i,
      );
    } finally {
      await f.cleanup();
    }
  });
});

test("rejects a ledger state transition between the initial and final reads", async () => {
  const f = await fixture("db-transition");
  try {
    let reads = 0;
    f.context.ledger = {
      async getAcceptedSemanticBinding() {
        reads += 1;
        return bindingFor(f.receipt, reads === 1 ? {} : { runStatus: "sealed-verifying" });
      },
    };
    await assert.rejects(
      () => exportAcceptedSemanticEvidence("db-transition", f.context),
      /run|changed|active/i,
    );
    assert.equal(reads, 2);
    assert.deepEqual(await readdir(f.exportRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("accepts monotonic slot and lease renewal between the two reads", async () => {
  const f = await fixture("db-transition");
  try {
    let reads = 0;
    f.context.ledger = {
      async getAcceptedSemanticBinding() {
        reads += 1;
        return bindingFor(
          f.receipt,
          reads === 1
            ? {}
            : {
                slotVersion: 9,
                monitorLeaseExpiresAt: "2026-07-16T01:06:00.000Z",
                supervisorLeaseExpiresAt: "2026-07-16T01:06:00.000Z",
              },
        );
      },
    };
    const exported = await exportAcceptedSemanticEvidence("db-transition", f.context);
    assert.equal(exported.slotVersion, 9);
    assert.equal(reads, 2);
  } finally {
    await f.cleanup();
  }
});

test("rejects changed producer metadata, secret-shaped values, and production caller roots", async () => {
  {
    const f = await fixture("db-transition");
    try {
      f.context.producer.repository = "fork/SPX";
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /producer/i,
      );
    } finally {
      await f.cleanup();
    }
  }
  {
    const f = await fixture("db-transition");
    try {
      f.context.producer = { ...producer(), token: "Bearer abcdefghijklmnop" };
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /producer|secret/i,
      );
    } finally {
      await f.cleanup();
    }
  }
  for (const [field, value] of [
    ["gate6Id", "caller-selected-gate"],
    ["receiptPath", "C:/caller-selected.json"],
    ["sql", "SELECT 1"],
  ]) {
    const f = await fixture("db-transition");
    try {
      f.context[field] = value;
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /context|field/i,
      );
      assert.equal(f.calls.length, 0);
    } finally {
      await f.cleanup();
    }
  }
  {
    const f = await fixture("db-transition");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        () => exportAcceptedSemanticEvidence("db-transition", f.context),
        /fixed|override|production/i,
      );
    } finally {
      process.env.NODE_ENV = previous;
      await f.cleanup();
    }
  }
});

test("accepts exactly one phase-only CLI argument and exposes only fixed production paths", () => {
  assert.equal(parseAcceptedEvidenceCliArgs(["--phase=db-transition"]), "db-transition");
  assert.equal(parseAcceptedEvidenceCliArgs(["--phase=pre-close"]), "pre-close");
  for (const argv of [
    [],
    ["--phase=task9"],
    ["--phase=db-transition", "--root=/tmp/caller"],
    ["--path=/tmp/caller", "--phase=db-transition"],
    ["--gate6-id=gate6-prod-001", "--phase=db-transition"],
    ["--sql=SELECT 1", "--phase=db-transition"],
  ]) {
    assert.throws(() => parseAcceptedEvidenceCliArgs(argv), /CLI|phase|argument/i);
  }
  assert.equal(ACCEPTED_EVIDENCE_EXPORT_ROOT, "/var/lib/spx-production-rollout/export/accepted");
  assert.deepEqual(ACCEPTED_EVIDENCE_PATHS, {
    "db-transition":
      "/var/lib/spx-production-rollout/export/accepted/accepted-db-transition-evidence.json",
    "pre-close": "/var/lib/spx-production-rollout/export/accepted/accepted-pre-close-evidence.json",
  });

  const modulePath = fileURLToPath(
    new URL("../scripts/gate6-accepted-evidence-export.mjs", import.meta.url),
  );
  const invoked = spawnSync(
    process.execPath,
    [modulePath, "--phase=db-transition", "--root=C:/forbidden"],
    { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } },
  );
  assert.notEqual(invoked.status, 0);
  assert.match(invoked.stderr, /gate6-accepted-evidence-export-failed/i);
  assert.doesNotMatch(invoked.stderr, /C:\/forbidden/i);
});
