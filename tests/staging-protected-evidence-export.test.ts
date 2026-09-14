import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  STAGING_PROTECTED_EVIDENCE_FILENAME,
  STAGING_PROTECTED_EVIDENCE_ROOT,
  buildStagingProtectedEvidence,
  createStagingProtectedEvidenceInstalledTestAdapter,
  exportInstalledStagingProtectedEvidence,
} from "../scripts/staging-protected-evidence-export.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";
import { PHASE3_SEMANTIC_SOURCE_IDS } from "../scripts/lib/phase3-staging-evidence.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import {
  PHASE3_GATE4_SOURCE_GRAPH,
  STAGING_GATE_PROOF_CONTRACTS,
} from "../scripts/lib/staging-gate-evidence.mjs";
import { REQUIRED_N_MINUS_ONE_ACTION_IDS } from "../scripts/phase4-n-minus-one-evidence-check.mjs";
import { REQUIRED_GATE5_ACTION_IDS } from "../scripts/phase4-rollout-evidence-check.mjs";
import { evaluateServiceFaultEvidence } from "../scripts/service-fault-evidence-check.mjs";
import { evaluateServiceWorkerEvidence } from "../scripts/service-worker-evidence-check.mjs";
import {
  STAGING_GATE_ACTIONS,
  STAGING_GATE_EVIDENCE_PATHS,
} from "../scripts/staging-gate-evidence-check.mjs";

const capturedAt = new Date("2026-07-16T08:30:00.000Z");

function digest(character: string): string {
  return character.repeat(64);
}

function validInput() {
  return {
    releaseBinding: {
      candidateSha: "a".repeat(40),
      imageDigest: `sha256:${digest("b")}`,
      releaseManifestSha256: digest("c"),
      environment: "staging",
      topology: "split",
      composeProject: "spx-staging",
      operatorBundleSha256: digest("d"),
      stagingTargetDescriptorSha256: digest("e"),
      stagingApprovalEnvelopeSha256: digest("f"),
      actionJournalHeadSha256: digest("1"),
      stagingRunId: "staging-run-4815",
    },
    gateEvidence: {
      gate1: { sourceSha256: digest("2"), checkerSha256: digest("3") },
      gate2: { sourceSha256: digest("4"), checkerSha256: digest("5") },
      gate3: { sourceSha256: digest("6"), checkerSha256: digest("7") },
      gate4: { sourceSha256: digest("8"), checkerSha256: digest("9") },
    },
    stagingBundles: {
      task9: { sourceSha256: digest("a"), checkerSha256: digest("b") },
      worker: { sourceSha256: digest("c"), checkerSha256: digest("d") },
      phase3: { sourceSha256: digest("e"), checkerSha256: digest("f") },
      phase4: { sourceSha256: digest("1"), checkerSha256: digest("2") },
      nMinusOne: { sourceSha256: digest("3"), checkerSha256: digest("4") },
    },
    guardClosed: true,
    producer: {
      repository: "fastest4u/SPX",
      environment: "staging",
      workflow: ".github/workflows/trusted-staging-protected-evidence.yml",
      workflowSha: "5".repeat(40),
      workflowFileSha256: digest("6"),
    },
  };
}

function installedPortFixture(input: ReturnType<typeof validInput>) {
  const source = (value: string) => ({
    sourceSha256: digest(value),
    checkerSha256: digest(value === "9" ? "a" : String(Number(value) + 1)),
    releaseBindingHeads: [input.releaseBinding.actionJournalHeadSha256],
  });
  return {
    source,
    ports: {
      async loadReleaseBinding() {
        return structuredClone(input.releaseBinding);
      },
      async loadProducerContext() {
        return structuredClone(input.producer);
      },
      async readGateEvidence() {
        return {
          gate1: source("2"),
          gate2: source("4"),
          gate3: source("6"),
          gate4: source("8"),
        };
      },
      async readTask9Evidence() {
        return source("1");
      },
      async readWorkerEvidence() {
        return source("3");
      },
      async readPhase3Evidence() {
        return source("5");
      },
      async readPhase4Evidence() {
        return { ...source("7"), guardClosed: true };
      },
      async readNMinusOneEvidence() {
        return source("9");
      },
      async readActionJournal() {
        return {
          headSha256: input.releaseBinding.actionJournalHeadSha256,
          acceptedHistoricalHeads: [input.releaseBinding.actionJournalHeadSha256],
        };
      },
      async writeArtifact(filename: string) {
        return `fixed-root/${filename}`;
      },
    },
  };
}

function stableSource(value: unknown) {
  const bytes = canonicalJson(value);
  return {
    value,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function phase3SourceGraph(binding: ReturnType<typeof validInput>["releaseBinding"]) {
  const graph = Object.fromEntries(
    PHASE3_SEMANTIC_SOURCE_IDS.map((id) => [
      id,
      stableSource(
        id === "phase3-lease-continuity"
          ? { schemaVersion: 1, continuity: { after: {} } }
          : id === "phase3-journal-snapshot"
            ? { schemaVersion: 1, headSha256: binding.actionJournalHeadSha256 }
            : { schemaVersion: 1, sourceId: id },
      ),
    ]),
  );
  graph["phase3-semantic"] = stableSource({ schemaVersion: 2, evidenceId: "protected-export" });
  return graph;
}

function gateProof(
  actionId: string,
  name: string,
  observedAt: string,
  binding: ReturnType<typeof validInput>["releaseBinding"],
  graph: ReturnType<typeof phase3SourceGraph>,
) {
  const contract = STAGING_GATE_PROOF_CONTRACTS[actionId][name];
  const common = {
    schemaVersion: actionId === "staging-gate-4-phase3" ? 2 : 1,
    gateActionId: actionId,
    proofName: name,
    sourceActionId: contract.sourceActionIds[0],
    observedAt,
    releaseBinding: binding,
    measurements: contract.measurements,
  };
  return actionId === "staging-gate-4-phase3"
    ? {
        ...common,
        sourceEvidence: PHASE3_GATE4_SOURCE_GRAPH[name].map((id: string) => ({
          id,
          sha256: graph[id].sha256,
        })),
      }
    : common;
}

async function writeCanonical(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, canonicalJson(value), { mode: 0o400 });
}

async function seedInstalledGateFixture(rootPath: string, input = validInput()) {
  const graph = phase3SourceGraph(input.releaseBinding);
  const adapter = createStagingProtectedEvidenceInstalledTestAdapter({
    rootPath,
    phase3SourceGraph: graph,
    async verifyPhase3Semantic() {
      return { ok: true };
    },
  });
  await writeCanonical(
    adapter.fixedPath("/var/lib/spx-staging-rollout/verified-release-binding.json"),
    input.releaseBinding,
  );
  await writeCanonical(
    adapter.fixedPath("/var/lib/spx-staging-rollout/protected-evidence-producer-context.json"),
    input.producer,
  );
  const gateRoot = adapter.fixedPath("/var/lib/spx-staging-rollout/evidence/gates");
  await mkdir(join(gateRoot, "proofs"), { recursive: true, mode: 0o700 });
  const capturedAt = new Date(Date.now() - 30_000).toISOString();
  for (const action of STAGING_GATE_ACTIONS) {
    const proofDirectory = join(gateRoot, "proofs", action.actionId);
    await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
    const proofs = [];
    for (const [index, name] of action.requiredProofs.entries()) {
      const observedAt = new Date(Date.now() - 60_000 + index * 100).toISOString();
      const document = gateProof(action.actionId, name, observedAt, input.releaseBinding, graph);
      const bytes = canonicalJson(document);
      const path = join(proofDirectory, `${name}.json`);
      await writeFile(path, bytes, { mode: 0o400 });
      proofs.push({
        name,
        ok: true,
        observedAt,
        evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await writeCanonical(adapter.fixedPath(STAGING_GATE_EVIDENCE_PATHS[action.actionId]), {
      schemaVersion: 1,
      actionId: action.actionId,
      gate: action.gate,
      stagingRunId: input.releaseBinding.stagingRunId,
      capturedAt,
      releaseBinding: input.releaseBinding,
      proofs,
    });
  }
  return { adapter, graph, input };
}

function terminalJournalSnapshot(input: ReturnType<typeof validInput>) {
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((expected, index) => {
    if (expected.kind === "emergency") {
      return {
        ...expected,
        state: "registered",
        occurrences: 0,
        terminalRecordSha256: null,
      };
    }
    return {
      ...expected,
      state: "succeeded",
      occurrences: 1,
      terminalRecordSha256:
        expected.actionId === "guard-close"
          ? input.releaseBinding.actionJournalHeadSha256
          : sha256Canonical({ actionId: expected.actionId, index }),
    };
  });
  return {
    headSha256: input.releaseBinding.actionJournalHeadSha256,
    binding: {
      stagingRunId: input.releaseBinding.stagingRunId,
      approvalEnvelopeSha256: input.releaseBinding.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: input.releaseBinding.stagingTargetDescriptorSha256,
      operatorBundleSha256: input.releaseBinding.operatorBundleSha256,
    },
    actions,
  };
}

function stagingPhase4Evidence(input: ReturnType<typeof validInput>, guardClosed = true) {
  const terminal = (actionIds: readonly string[]) =>
    actionIds.map((actionId) => ({ actionId, status: "succeeded", occurrences: 1 }));
  return {
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    drillMode: "staging",
    composeProject: "spx-staging",
    release: { valid: true, candidateExact: true },
    targetDescriptor: { valid: true, environment: "staging", project: "spx-staging" },
    operatorBundle: { valid: true, installedExact: true },
    binding: {
      stagingRunIdExact: true,
      approvalEnvelopeExact: true,
      actionIndexExact: true,
      databaseFingerprintExact: true,
    },
    host: { a3HostIdentityMatches: true, productionHostUnchanged: true },
    guard: {
      sameInstanceAsTask10AndGate4: true,
      heartbeatFreshThroughout: true,
      watchdogFreshThroughout: true,
      continuityGapMs: 0,
    },
    runtime: { baselineLeaseOwnerExact: true, identitiesExact: true, databaseRoutingExact: true },
    migration: { checksumsValid: true, schemaCompatible: true },
    singleton: { firstReady: true, competingOwnerRejected: true, ownerCount: 1 },
    baseline: { localWatermark: 100, webReady: true, productionReady: true },
    routed: { routingWatermark: 110, producersRemote: true, webRemote: true, streamsRemote: true },
    replay: { resumedAtOrAfter: 110, raceDuplicates: 0 },
    pressure: { retentionOk: true, backpressureOk: true, slowClientResynced: true },
    proxyTls: { bufferingDisabled: true, cursorPreserved: true, upstreamIdentityVerified: true },
    dbFault: {
      stagingRealtimeUnavailable: true,
      targetedReaderDegraded: true,
      directDbClientsHealthy: true,
      stagingWebReady: true,
      workerAlive: true,
      productionReady: true,
    },
    recovered: { realtimeReady: true, cursorAtOrAfter: 110 },
    rollback: { localWatermark: 110, webReady: true, forwardRouteRestored: true },
    nMinusOne: {
      bundleValid: true,
      allRollbackEligibleRolesCovered: true,
      sideEffects: 0,
      fixtureDrift: 0,
    },
    cleanup: { allStagingStopped: true, guardClosed, watchdogClosed: true },
    actionJournal: {
      headSha256: input.releaseBinding.actionJournalHeadSha256,
      required: terminal(REQUIRED_GATE5_ACTION_IDS),
      pending: 0,
      ambiguous: 0,
      replayed: 0,
    },
  };
}

function nMinusOneEvidence(input: ReturnType<typeof validInput>, currentSchema = 37) {
  const roles = [
    "web-api",
    "notification-service",
    "line-service",
    "ocr-service",
    "worker-ifn-split",
    "worker-ptwl-split",
  ];
  return {
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    drillMode: "staging-n-minus-one",
    composeProject: "spx-staging",
    candidateSha: input.releaseBinding.candidateSha,
    candidateImageDigest: input.releaseBinding.imageDigest,
    nMinusOneSha: "c".repeat(40),
    nMinusOneImageDigest: `sha256:${digest("d")}`,
    candidateManifestSha256: digest("e"),
    nMinusOneManifestSha256: digest("f"),
    targetDescriptorValid: true,
    operatorBundleValid: true,
    a3HostIdentityMatches: true,
    stagingRunIdExact: true,
    approvalEnvelopeExact: true,
    guardContinuous: true,
    watchdogContinuous: true,
    baselineIdentityExact: true,
    productionChanged: false,
    productionReadyThroughout: true,
    migrationChecksumsValid: true,
    currentSchema,
    candidateSchemaRange: { min: 35, max: 37 },
    nMinusOneSchemaRange: { min: 34, max: 37 },
    signedRollbackEligibleRoles: roles,
    contractRoles: roles,
    probeInvocations: roles,
    roles: roles.map((role) => ({
      role,
      usesDatabase: role !== "ocr-service",
      dbCredentialPresent: role !== "ocr-service",
      connectAttempts: role === "ocr-service" ? 0 : 1,
      representativeReadPassed: role !== "ocr-service",
      representativeWritePassed: role !== "ocr-service",
      transactionRolledBack: role !== "ocr-service",
      fixtureHashUnchanged: true,
      fixtureRowCountUnchanged: true,
      ddlStatements: 0,
      providerCalls: 0,
      backgroundLoops: 0,
      liveClaims: 0,
      localBoundaryPassed: role === "ocr-service",
    })),
    fixtureDrift: 0,
    providerCalls: 0,
    backgroundLoops: 0,
    liveClaims: 0,
    timestamps: {
      preflight: "2026-07-11T00:00:00.000Z",
      start: "2026-07-11T00:01:00.000Z",
      verify: "2026-07-11T00:02:00.000Z",
      rollbackForward: "2026-07-11T00:03:00.000Z",
      stop: "2026-07-11T00:04:00.000Z",
    },
    actionJournal: {
      headSha256: input.releaseBinding.actionJournalHeadSha256,
      required: REQUIRED_N_MINUS_ONE_ACTION_IDS.map((actionId) => ({
        actionId,
        status: "succeeded",
        occurrences: 1,
      })),
      pending: 0,
      ambiguous: 0,
      replayed: 0,
    },
  };
}

test("exports the fixed protected evidence filename", () => {
  assert.equal(STAGING_PROTECTED_EVIDENCE_FILENAME, "staging-protected-evidence.json");
});

test("reuses the Task 9 and worker semantic evaluators without CLI side effects", () => {
  assert.equal(typeof evaluateServiceFaultEvidence, "function");
  assert.equal(typeof evaluateServiceWorkerEvidence, "function");
});

test("exposes the fixed installed protected-evidence export boundary", () => {
  assert.equal(STAGING_PROTECTED_EVIDENCE_ROOT, "/var/lib/spx-staging-rollout/evidence");
  assert.equal(typeof exportInstalledStagingProtectedEvidence, "function");
});

test("collects only normalized installed sources and persists one canonical artifact", async () => {
  const input = validInput();
  const source = (value: string) => ({
    sourceSha256: digest(value),
    checkerSha256: digest(value === "9" ? "a" : String(Number(value) + 1)),
    releaseBindingHeads: [input.releaseBinding.actionJournalHeadSha256],
  });
  let written: { filename: string; bytes: string } | undefined;
  const result = await exportInstalledStagingProtectedEvidence({
    now: capturedAt,
    ports: {
      async loadReleaseBinding() {
        return structuredClone(input.releaseBinding);
      },
      async loadProducerContext() {
        return structuredClone(input.producer);
      },
      async readGateEvidence() {
        return {
          gate1: source("2"),
          gate2: source("4"),
          gate3: source("6"),
          gate4: source("8"),
        };
      },
      async readTask9Evidence() {
        return source("1");
      },
      async readWorkerEvidence() {
        return source("3");
      },
      async readPhase3Evidence() {
        return source("5");
      },
      async readPhase4Evidence() {
        return { ...source("7"), guardClosed: true };
      },
      async readNMinusOneEvidence() {
        return source("9");
      },
      async readActionJournal() {
        return {
          headSha256: input.releaseBinding.actionJournalHeadSha256,
          acceptedHistoricalHeads: [input.releaseBinding.actionJournalHeadSha256],
        };
      },
      async writeArtifact(filename: string, bytes: string) {
        written = { filename, bytes };
        return `fixed-root/${filename}`;
      },
    },
  });
  assert.equal(result.path, `fixed-root/${STAGING_PROTECTED_EVIDENCE_FILENAME}`);
  assert.equal(result.evidence.capturedAt, capturedAt.toISOString());
  assert.deepEqual(written, {
    filename: STAGING_PROTECTED_EVIDENCE_FILENAME,
    bytes: canonicalJson(result.evidence),
  });
});

test("exports through the real installed readers and create-once writer under a test root", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "spx-protected-export-"));
  try {
    const fixture = await seedInstalledGateFixture(rootPath);
    const normalized = installedPortFixture(fixture.input);
    const snapshot = terminalJournalSnapshot(fixture.input);
    const ports = {
      ...normalized.ports,
      loadReleaseBinding: fixture.adapter.loadReleaseBinding,
      loadProducerContext: fixture.adapter.loadProducerContext,
      readGateEvidence: fixture.adapter.readGateEvidence,
      async readActionJournal() {
        return fixture.adapter.validateActionJournalSnapshot(snapshot, fixture.input.releaseBinding);
      },
      writeArtifact: fixture.adapter.writeArtifact,
    };

    const result = await exportInstalledStagingProtectedEvidence({ now: capturedAt, ports });
    const bytes = await readFile(result.path, "utf8");
    assert.equal(bytes, canonicalJson(result.evidence));
    assert.equal(
      result.path,
      fixture.adapter.fixedPath(
        "/var/lib/spx-staging-rollout/evidence/staging-protected-evidence.json",
      ),
    );
    await assert.rejects(
      () => exportInstalledStagingProtectedEvidence({ now: capturedAt, ports }),
      /exist|create-once|artifact/i,
    );

    const source = await readFile(
      new URL("../scripts/staging-protected-evidence-export.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /O_EXCL/);
    assert.match(source, /await handle\.sync\(\)/);
    assert.match(source, /await parent\.sync\(\)/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("real installed gate readers reject filesystem and binding tampering", async (t) => {
  async function rejectsMutation(
    mutate: (fixture: Awaited<ReturnType<typeof seedInstalledGateFixture>>) => Promise<void>,
    pattern: RegExp,
  ) {
    const rootPath = await mkdtemp(join(tmpdir(), "spx-protected-gate-reject-"));
    try {
      const fixture = await seedInstalledGateFixture(rootPath);
      await mutate(fixture);
      const normalized = installedPortFixture(fixture.input);
      await assert.rejects(
        () =>
          exportInstalledStagingProtectedEvidence({
            now: capturedAt,
            ports: {
              ...normalized.ports,
              readGateEvidence: fixture.adapter.readGateEvidence,
            },
          }),
        pattern,
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }

  await t.test("an extra installed file", () =>
    rejectsMutation(async ({ adapter }) => {
      await writeCanonical(
        join(adapter.fixedPath("/var/lib/spx-staging-rollout/evidence/gates"), "extra.json"),
        { unexpected: true },
      );
    }, /unexpected|missing entry/i));

  await t.test("a symlinked aggregate", () =>
    rejectsMutation(async ({ adapter }) => {
      const gateRoot = adapter.fixedPath("/var/lib/spx-staging-rollout/evidence/gates");
      const target = adapter.fixedPath("/gate-target");
      await rename(gateRoot, target);
      await symlink(target, gateRoot, "junction");
    }, /symlink|entry type|regular/i));

  await t.test("a non-canonical aggregate", () =>
    rejectsMutation(async ({ adapter }) => {
      const aggregate = adapter.fixedPath(STAGING_GATE_EVIDENCE_PATHS[STAGING_GATE_ACTIONS[0].actionId]);
      const value = JSON.parse(await readFile(aggregate, "utf8"));
      await unlink(aggregate);
      await writeFile(
        aggregate,
        JSON.stringify({ schemaVersion: value.schemaVersion, ...value }),
      );
    }, /canonical/i));

  await t.test("changed proof bytes", () =>
    rejectsMutation(async ({ adapter }) => {
      const action = STAGING_GATE_ACTIONS[0];
      const proof = join(
        adapter.fixedPath("/var/lib/spx-staging-rollout/evidence/gates/proofs"),
        action.actionId,
        `${action.requiredProofs[0]}.json`,
      );
      const bytes = await readFile(proof, "utf8");
      await unlink(proof);
      await writeFile(proof, `${bytes} `);
    }, /proof content hash changed/i));

  await t.test("a mismatched staging run", () =>
    rejectsMutation(async ({ adapter }) => {
      const aggregate = adapter.fixedPath(STAGING_GATE_EVIDENCE_PATHS[STAGING_GATE_ACTIONS[0].actionId]);
      const value = JSON.parse(await readFile(aggregate, "utf8"));
      value.stagingRunId = "other-staging-run";
      await unlink(aggregate);
      await writeFile(aggregate, canonicalJson(value));
    }, /release binding|staging identity|staging run/i));
});

test("real installed Phase 4 and N-1 readers reject stale or incompatible evidence", async (t) => {
  async function withFixture(
    name: string,
    run: (fixture: Awaited<ReturnType<typeof seedInstalledGateFixture>>) => Promise<void>,
  ) {
    const rootPath = await mkdtemp(join(tmpdir(), `spx-protected-${name}-`));
    try {
      await run(await seedInstalledGateFixture(rootPath));
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }

  await t.test("a stale/open guard", () =>
    withFixture("phase4", async ({ adapter, input }) => {
      await writeCanonical(
        adapter.fixedPath(
          "/var/lib/spx-staging-rollout/evidence/phase4-staging/phase4-evidence.json",
        ),
        { evidence: stagingPhase4Evidence(input, false), releaseBinding: input.releaseBinding },
      );
      const normalized = installedPortFixture(input);
      await assert.rejects(
        () =>
          exportInstalledStagingProtectedEvidence({
            now: capturedAt,
            ports: { ...normalized.ports, readPhase4Evidence: adapter.readPhase4Evidence },
          }),
        /Phase 4|checker|guard/i,
      );
    }));

  await t.test("an N-1 schema range mismatch", () =>
    withFixture("n-minus-one", async ({ adapter, input }) => {
      await writeCanonical(
        adapter.fixedPath(
          "/var/lib/spx-staging-rollout/evidence/phase4-n-minus-one-staging/n-minus-one-evidence.json",
        ),
        { evidence: nMinusOneEvidence(input, 38), releaseBinding: input.releaseBinding },
      );
      const normalized = installedPortFixture(input);
      await assert.rejects(
        () =>
          exportInstalledStagingProtectedEvidence({
            now: capturedAt,
            ports: { ...normalized.ports, readNMinusOneEvidence: adapter.readNMinusOneEvidence },
          }),
        /N-1|checker|range/i,
      );
    }));
});

test("real terminal-journal validation rejects open, ambiguous, and non-terminal states", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "spx-protected-journal-"));
  try {
    const fixture = await seedInstalledGateFixture(rootPath);
    const normalized = installedPortFixture(fixture.input);
    const nonEmergencyIndex = REQUIRED_STAGING_ACTION_PLAN.findIndex(
      (action) => action.kind !== "emergency" && action.actionId !== "guard-close",
    );

    for (const scenario of [
      {
        name: "open",
        mutate(snapshot: ReturnType<typeof terminalJournalSnapshot>) {
          snapshot.actions[nonEmergencyIndex].state = "registered";
          snapshot.actions[nonEmergencyIndex].occurrences = 0;
          snapshot.actions[nonEmergencyIndex].terminalRecordSha256 = null;
        },
      },
      {
        name: "ambiguous",
        mutate(snapshot: ReturnType<typeof terminalJournalSnapshot>) {
          snapshot.actions[nonEmergencyIndex].occurrences = 2;
        },
      },
      {
        name: "non-terminal guard close",
        mutate(snapshot: ReturnType<typeof terminalJournalSnapshot>) {
          const guard = snapshot.actions.find((action) => action.actionId === "guard-close")!;
          guard.terminalRecordSha256 = digest("9");
        },
      },
    ]) {
      await t.test(scenario.name, async () => {
        const snapshot = terminalJournalSnapshot(fixture.input);
        scenario.mutate(snapshot);
        await assert.rejects(
          () =>
            exportInstalledStagingProtectedEvidence({
              now: capturedAt,
              ports: {
                ...normalized.ports,
                async readActionJournal() {
                  return fixture.adapter.validateActionJournalSnapshot(
                    snapshot,
                    fixture.input.releaseBinding,
                  );
                },
              },
            }),
          /journal|open|failed|ambiguous|terminal/i,
        );
      });
    }
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("rejects evidence whose historical binding head is outside the authenticated journal", async () => {
  const input = validInput();
  const fixture = installedPortFixture(input);
  await assert.rejects(
    () =>
      exportInstalledStagingProtectedEvidence({
        now: capturedAt,
        ports: {
          ...fixture.ports,
          async readTask9Evidence() {
            return {
              ...fixture.source("1"),
              releaseBindingHeads: [digest("b")],
            };
          },
        },
      }),
    /outside the authenticated journal/i,
  );
});

test("rejects environment path overrides before reading installed evidence", async () => {
  const previous = process.env.SPX_STAGING_PROTECTED_EVIDENCE_ROOT;
  process.env.SPX_STAGING_PROTECTED_EVIDENCE_ROOT = "caller-selected";
  try {
    await assert.rejects(
      () => exportInstalledStagingProtectedEvidence(),
      /path overrides are forbidden/i,
    );
  } finally {
    if (previous === undefined) delete process.env.SPX_STAGING_PROTECTED_EVIDENCE_ROOT;
    else process.env.SPX_STAGING_PROTECTED_EVIDENCE_ROOT = previous;
  }
});

test("builds the normalized protected staging evidence document", () => {
  const input = validInput();
  const releaseBindingSha256 = sha256Canonical(input.releaseBinding);
  const digestEvidence = (
    kind: string,
    evidence: { sourceSha256: string; checkerSha256: string },
  ) =>
    sha256Canonical({
      schemaVersion: 1,
      kind,
      releaseBindingSha256,
      sourceSha256: evidence.sourceSha256,
      checkerSha256: evidence.checkerSha256,
    });
  const phase4Sha256 = digestEvidence("phase4", input.stagingBundles.phase4);
  const nMinusOneSha256 = digestEvidence("n-minus-one", input.stagingBundles.nMinusOne);

  assert.deepEqual(buildStagingProtectedEvidence(input, { now: capturedAt }), {
    schemaVersion: 1,
    candidateSha: input.releaseBinding.candidateSha,
    imageDigest: input.releaseBinding.imageDigest,
    releaseManifestSha256: input.releaseBinding.releaseManifestSha256,
    stagingTargetDescriptorSha256: input.releaseBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: input.releaseBinding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: input.releaseBinding.stagingApprovalEnvelopeSha256,
    stagingRunId: input.releaseBinding.stagingRunId,
    composeProject: input.releaseBinding.composeProject,
    gateEvidenceSha256: {
      gate1: digestEvidence("gate-1", input.gateEvidence.gate1),
      gate2: digestEvidence("gate-2", input.gateEvidence.gate2),
      gate3: digestEvidence("gate-3", input.gateEvidence.gate3),
      gate4: digestEvidence("gate-4", input.gateEvidence.gate4),
      gate5: sha256Canonical({
        schemaVersion: 1,
        kind: "gate-5",
        releaseBindingSha256,
        phase4Sha256,
        nMinusOneSha256,
      }),
    },
    stagingBundles: {
      task9Sha256: digestEvidence("task9", input.stagingBundles.task9),
      workerSha256: digestEvidence("worker", input.stagingBundles.worker),
      phase3Sha256: digestEvidence("phase3", input.stagingBundles.phase3),
      phase4Sha256,
      nMinusOneSha256,
    },
    actionJournalHeadSha256: input.releaseBinding.actionJournalHeadSha256,
    guardClosed: true,
    capturedAt: capturedAt.toISOString(),
    producer: input.producer,
  });
});

test("rejects malformed protected staging evidence input", async (t) => {
  await t.test("an invalid capture date", () => {
    assert.throws(
      () => buildStagingProtectedEvidence(validInput(), { now: new Date(Number.NaN) }),
      /valid Date/,
    );
  });

  await t.test("extra or missing exact keys", () => {
    const extraInput = Object.assign(validInput(), { unexpected: true });
    assert.throws(() => buildStagingProtectedEvidence(extraInput), /exactly/);

    const missingInput = validInput();
    delete (missingInput.gateEvidence as Partial<typeof missingInput.gateEvidence>).gate4;
    assert.throws(() => buildStagingProtectedEvidence(missingInput), /exactly/);

    const nestedExtraInput = validInput();
    Object.assign(nestedExtraInput.stagingBundles.task9, { extra: digest("7") });
    assert.throws(() => buildStagingProtectedEvidence(nestedExtraInput), /exactly/);
  });

  await t.test("a release binding for a different environment", () => {
    const input = validInput();
    input.releaseBinding = {
      candidateSha: "a".repeat(40),
      imageDigest: `sha256:${digest("b")}`,
      releaseManifestSha256: digest("c"),
      environment: "supervised-production",
      topology: "split",
      composeProject: "spx-production",
      operatorBundleSha256: digest("d"),
      targetDescriptorSha256: digest("e"),
      productionIdentityApprovalSha256: digest("f"),
    } as typeof input.releaseBinding;
    assert.throws(() => buildStagingProtectedEvidence(input), /staging release binding/);
  });

  await t.test("invalid and all-zero digests", () => {
    const uppercaseInput = validInput();
    uppercaseInput.gateEvidence.gate1.sourceSha256 = digest("A");
    assert.throws(() => buildStagingProtectedEvidence(uppercaseInput), /nonzero lowercase SHA-256/);

    const zeroInput = validInput();
    zeroInput.stagingBundles.worker.checkerSha256 = digest("0");
    assert.throws(() => buildStagingProtectedEvidence(zeroInput), /nonzero lowercase SHA-256/);

    const zeroBindingInput = validInput();
    zeroBindingInput.releaseBinding.releaseManifestSha256 = digest("0");
    assert.throws(
      () => buildStagingProtectedEvidence(zeroBindingInput),
      /nonzero lowercase SHA-256/,
    );
  });

  await t.test("an open guard", () => {
    const input = validInput();
    input.guardClosed = false;
    assert.throws(() => buildStagingProtectedEvidence(input), /guardClosed must be true/);
  });

  await t.test("an untrusted producer identity", () => {
    const input = validInput();
    input.producer.repository = "fork/SPX";
    assert.throws(() => buildStagingProtectedEvidence(input), /producer repository/);

    const badShaInput = validInput();
    badShaInput.producer.workflowSha = "A".repeat(40);
    assert.throws(() => buildStagingProtectedEvidence(badShaInput), /workflow SHA/);
  });

  await t.test("secret-shaped content", () => {
    const input = validInput();
    input.releaseBinding.stagingRunId = "sk-abcdefghijklmnop";
    assert.throws(() => buildStagingProtectedEvidence(input), /secret-shaped/);
  });

  await t.test("canonical output larger than one MiB", () => {
    const oversizedDate = new Date(capturedAt);
    Object.defineProperty(oversizedDate, "toISOString", {
      value: () => "2".repeat(1024 * 1024 + 1),
    });
    assert.throws(
      () => buildStagingProtectedEvidence(validInput(), { now: oversizedDate }),
      /one MiB/,
    );
  });
});

test("deep-freezes its output without mutating or freezing caller input", () => {
  const input = validInput();
  const inputSnapshot = structuredClone(input);
  const output = buildStagingProtectedEvidence(input, { now: capturedAt });

  assert.deepEqual(input, inputSnapshot);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.releaseBinding), false);
  assert.equal(Object.isFrozen(input.producer), false);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.gateEvidenceSha256), true);
  assert.equal(Object.isFrozen(output.stagingBundles), true);
  assert.equal(Object.isFrozen(output.producer), true);
  assert.equal(Reflect.set(output.producer, "repository", "mutated/SPX"), false);
  assert.equal(output.producer.repository, "fastest4u/SPX");
});

test("serializes deterministically regardless of caller key insertion order", () => {
  const orderedInput = validInput();
  const reorderedInput = validInput();
  reorderedInput.producer = {
    workflowFileSha256: reorderedInput.producer.workflowFileSha256,
    workflowSha: reorderedInput.producer.workflowSha,
    workflow: reorderedInput.producer.workflow,
    environment: reorderedInput.producer.environment,
    repository: reorderedInput.producer.repository,
  };

  const ordered = buildStagingProtectedEvidence(orderedInput, { now: capturedAt });
  const reordered = buildStagingProtectedEvidence(reorderedInput, { now: capturedAt });

  assert.deepEqual(reordered, ordered);
  assert.equal(JSON.stringify(reordered), JSON.stringify(ordered));
  assert.notEqual(reordered, ordered);
  assert.notEqual(reordered.producer, ordered.producer);
});

test("applies the nonzero rule to 64-character digests, not 40-character SHAs", () => {
  const input = validInput();
  input.releaseBinding.candidateSha = "0".repeat(40);
  input.producer.workflowSha = "0".repeat(40);

  const output = buildStagingProtectedEvidence(input, { now: capturedAt });

  assert.equal(output.candidateSha, "0".repeat(40));
  assert.equal(output.producer.workflowSha, "0".repeat(40));
});

test("rejects non-JSON release binding properties without invoking accessors", async (t) => {
  await t.test("a symbol-keyed secret-shaped extra", () => {
    const input = validInput();
    Object.defineProperty(input.releaseBinding, Symbol("secret-token"), {
      value: "Bearer abcdefghijklmnop",
      enumerable: true,
    });

    assert.throws(
      () => buildStagingProtectedEvidence(input, { now: capturedAt }),
      /release binding must be an exact JSON record/,
    );
  });

  await t.test("a non-enumerable extra", () => {
    const input = validInput();
    Object.defineProperty(input.releaseBinding, "hiddenEvidence", {
      value: "not-json-visible",
      enumerable: false,
    });

    assert.throws(
      () => buildStagingProtectedEvidence(input, { now: capturedAt }),
      /release binding must be an exact JSON record/,
    );
  });

  await t.test("an accessor property without invoking its getter", () => {
    const input = validInput();
    let getterCalls = 0;
    Object.defineProperty(input.releaseBinding, "candidateSha", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("release binding getter was invoked");
      },
    });

    assert.throws(
      () => buildStagingProtectedEvidence(input, { now: capturedAt }),
      /release binding must be an exact JSON record/,
    );
    assert.equal(getterCalls, 0);
  });

  await t.test("an expected property made non-enumerable", () => {
    const input = validInput();
    Object.defineProperty(input.releaseBinding, "candidateSha", {
      value: input.releaseBinding.candidateSha,
      configurable: true,
      writable: true,
      enumerable: false,
    });

    assert.throws(
      () => buildStagingProtectedEvidence(input, { now: capturedAt }),
      /release binding must be an exact JSON record/,
    );
  });
});
