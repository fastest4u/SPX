import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import { PHASE3_SEMANTIC_SOURCE_IDS } from "../scripts/lib/phase3-staging-evidence.mjs";
import {
  PHASE3_GATE4_SOURCE_GRAPH,
  STAGING_GATE_PROOF_CONTRACTS,
} from "../scripts/lib/staging-gate-evidence.mjs";
import {
  STAGING_GATE_ACTIONS,
  STAGING_GATE_EVIDENCE_PATHS,
  buildStagingGateSemanticCommands,
  parseStagingGateInvocation,
  readFixedPhase3SourceGraph,
  validateStagingGateEvidence,
  verifyHistoricalStagingGateEvidence,
  verifyStagingGateEvidence,
} from "../scripts/staging-gate-evidence-check.mjs";

const H = (value: string) => value.repeat(64);
const nowMs = Date.now();
const stagingRunId = "staging-run-20260710-001";
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;
const binding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: H("c"),
  environment: "staging",
  topology: "split",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: H("d"),
  operatorBundleSha256: H("e"),
  stagingApprovalEnvelopeSha256: H("f"),
  actionJournalHeadSha256: H("1"),
  stagingRunId,
};

function artifact(actionId: string) {
  const action = STAGING_GATE_ACTIONS.find((entry) => entry.actionId === actionId)!;
  return {
    schemaVersion: 1,
    actionId,
    gate: action.gate,
    stagingRunId,
    capturedAt: new Date(nowMs - 60_000).toISOString(),
    releaseBinding: binding,
    proofs: action.requiredProofs.map((name, index) => ({
      name,
      ok: true,
      observedAt: new Date(nowMs - 120_000 + index * 1_000).toISOString(),
      evidenceSha256: String((index % 9) + 1).repeat(64),
    })),
  };
}

function proofDocument(actionId: string, name: string, observedAt: string) {
  const contract = STAGING_GATE_PROOF_CONTRACTS[actionId][name];
  const value = {
    schemaVersion: actionId === "staging-gate-4-phase3" ? 2 : 1,
    gateActionId: actionId,
    proofName: name,
    sourceActionId: contract.sourceActionIds[0],
    observedAt,
    releaseBinding: binding,
    measurements: contract.measurements,
  };
  if (actionId !== "staging-gate-4-phase3") return value;
  return {
    ...value,
    sourceEvidence: PHASE3_GATE4_SOURCE_GRAPH[name].map((id: string) => ({
      id,
      sha256: fixedSourceGraph()[id].sha256,
    })),
  };
}

function withProofBytes(gate: ReturnType<typeof artifact>, proofBytes: Map<string, Buffer>) {
  return {
    ...gate,
    proofs: gate.proofs.map((proof) => ({
      ...proof,
      evidenceSha256: createHash("sha256").update(proofBytes.get(proof.name)!).digest("hex"),
    })),
  };
}

const continuityAfter = {
  guard: {
    leaseId: "11111111-1111-4111-8111-111111111111",
    state: "armed",
    pid: 101,
    startedMonotonicMs: 1_000,
    heartbeatMonotonicMs: 9_000,
    heartbeatAgeMs: 1_000,
    baselineP95LatencyMs: 25,
  },
  watchdog: {
    leaseId: "22222222-2222-4222-8222-222222222222",
    state: "armed",
    pid: 202,
    startedMonotonicMs: 2_000,
    heartbeatMonotonicMs: 9_100,
    heartbeatAgeMs: 900,
    baselineP95LatencyMs: null,
  },
};

function stableSource(value: unknown) {
  const bytes = canonicalJson(value);
  return {
    value,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fixedSourceGraph() {
  const graph = Object.fromEntries(PHASE3_SEMANTIC_SOURCE_IDS.map((id) => [
    id,
    stableSource(id === "phase3-lease-continuity"
      ? { schemaVersion: 1, continuity: { after: continuityAfter } }
      : id === "phase3-journal-snapshot"
        ? { schemaVersion: 1, headSha256: binding.actionJournalHeadSha256 }
      : { schemaVersion: 1, sourceId: id }),
  ]));
  graph["phase3-semantic"] = stableSource({
    schemaVersion: 2,
    evidenceId: "phase3-semantic-test",
  });
  return graph;
}

function liveLeases(overrides: Record<string, unknown> = {}) {
  return {
    stagingRunId,
    guard: {
      schemaVersion: 1,
      role: "guard",
      breachCount: 0,
      stagingRunId,
      ...continuityAfter.guard,
      heartbeatMonotonicMs: 9_500,
      heartbeatAgeMs: 500,
    },
    watchdog: {
      schemaVersion: 1,
      role: "watchdog",
      breachCount: 0,
      stagingRunId,
      ...continuityAfter.watchdog,
      heartbeatMonotonicMs: 9_600,
      heartbeatAgeMs: 400,
    },
    maxAgeMs: 10_000,
    ...overrides,
  };
}

function unusedGatePorts(readProof: (actionId: string, name: string) => Promise<Buffer>) {
  return {
    readProof,
    async readFixedPhase3SourceGraph() { throw new Error("not Gate 4"); },
    async verifyPhase3Semantic() { throw new Error("not Gate 4"); },
    async loadLeases() { throw new Error("not Gate 4"); },
  };
}

async function main(): Promise<void> {
  assert.deepEqual(
    STAGING_GATE_ACTIONS.map(({ actionId, scope, gate }) => [actionId, scope, gate]),
    [
      ["staging-gate-1-baseline", "gate-1", "gate-1"],
      ["staging-gate-2-worker", "gate-2", "gate-2"],
      ["staging-gate-3-handoff", "gate-3", "gate-3"],
      ["staging-gate-4-phase3", "gate-4", "gate-4"],
    ],
  );
  assert.deepEqual(STAGING_GATE_EVIDENCE_PATHS, {
    "staging-gate-1-baseline": "/var/lib/spx-staging-rollout/evidence/gates/gate-1.json",
    "staging-gate-2-worker": "/var/lib/spx-staging-rollout/evidence/gates/gate-2.json",
    "staging-gate-3-handoff": "/var/lib/spx-staging-rollout/evidence/gates/gate-3.json",
    "staging-gate-4-phase3": "/var/lib/spx-staging-rollout/evidence/gates/gate-4.json",
  });
  assert.deepEqual(buildStagingGateSemanticCommands("staging-gate-1-baseline", operatorRoot), []);
  assert.deepEqual(buildStagingGateSemanticCommands("staging-gate-2-worker", operatorRoot), [[
    "/usr/bin/node",
    `${operatorRoot}/scripts/service-worker-evidence-check.mjs`,
    "--environment=staging",
    "--handoff-dir=/var/lib/spx-staging-rollout/evidence/worker-staging",
  ]]);
  assert.deepEqual(buildStagingGateSemanticCommands("staging-gate-3-handoff", operatorRoot), []);
  assert.deepEqual(buildStagingGateSemanticCommands(
    "staging-gate-4-phase3",
    operatorRoot,
  ), []);
  assert.equal(
    "n-minus-one-compatible" in
      STAGING_GATE_PROOF_CONTRACTS["staging-gate-4-phase3"],
    false,
  );
  assert.throws(() => parseStagingGateInvocation(["gate-1"], process.env), /zero|argument/i);
  await assert.rejects(
    (readFixedPhase3SourceGraph as (...args: unknown[]) => Promise<unknown>)(
      "caller-selected-source",
    ),
    /zero|argument|fixed|source/i,
  );

  for (const action of STAGING_GATE_ACTIONS) {
    const inherited = parseStagingGateInvocation([], {
      SPX_STAGING_ACTION_ID: action.actionId,
      SPX_STAGING_ACTION_SCOPE: action.scope,
      SPX_STAGING_RUN_ID: stagingRunId,
    });
    assert.equal(inherited.actionId, action.actionId);
    assert.deepEqual(
      validateStagingGateEvidence(artifact(action.actionId), binding, action.actionId, {
        nowMs,
      }),
      { ok: true, actionId: action.actionId, proofCount: action.requiredProofs.length },
    );
  }

  const gate2 = artifact("staging-gate-2-worker");
  assert.throws(
    () => validateStagingGateEvidence(
      { ...gate2, proofs: gate2.proofs.slice(1) },
      binding,
      gate2.actionId,
      { nowMs },
    ),
    /proof|evidence/i,
  );
  assert.throws(
    () => validateStagingGateEvidence(
      { ...gate2, releaseBinding: { ...binding, composeProject: "spx-production" } },
      binding,
      gate2.actionId,
      { nowMs },
    ),
    /binding|staging/i,
  );
  assert.throws(
    () => validateStagingGateEvidence(
      { ...gate2, proofs: gate2.proofs.map((proof, index) => index === 0 ? { ...proof, evidenceSha256: H("0") } : proof) },
      binding,
      gate2.actionId,
      { nowMs },
    ),
    /evidence|hash/i,
  );

  const proofBytes = new Map(gate2.proofs.map((proof) => [
    proof.name,
    Buffer.from(canonicalJson(proofDocument(gate2.actionId, proof.name, proof.observedAt))),
  ]));
  const boundGate2 = withProofBytes(gate2, proofBytes);
  assert.equal((await verifyStagingGateEvidence(boundGate2, binding, gate2.actionId, {
    ...unusedGatePorts(async (_actionId: string, name: string) => proofBytes.get(name)!),
  })).ok, true);
  const temporallyInvertedGate2 = withProofBytes({
    ...gate2,
    capturedAt: new Date(nowMs - 8 * 60_000).toISOString(),
  }, proofBytes);
  await assert.rejects(
    verifyStagingGateEvidence(temporallyInvertedGate2, binding, gate2.actionId, {
      ...unusedGatePorts(async (_actionId: string, name: string) => proofBytes.get(name)!),
    }),
    /capture|causal|observation|temporal/i,
  );
  await assert.rejects(
    verifyStagingGateEvidence(boundGate2, binding, gate2.actionId, {
      ...unusedGatePorts(async () => Buffer.from("tampered durable proof")),
    }),
    /durable|hash|changed/i,
  );

  const noncanonicalBytes = new Map(proofBytes);
  noncanonicalBytes.set(
    gate2.proofs[0].name,
    Buffer.from(`${proofBytes.get(gate2.proofs[0].name)!.toString("utf8")}\n`),
  );
  await assert.rejects(
    verifyStagingGateEvidence(
      withProofBytes(gate2, noncanonicalBytes),
      binding,
      gate2.actionId,
      {
        ...unusedGatePorts(async (_actionId: string, name: string) => noncanonicalBytes.get(name)!),
      },
    ),
    /canonical|proof/i,
  );

  const falseProofBytes = new Map(proofBytes);
  const falseForward = proofDocument(
    gate2.actionId,
    gate2.proofs[0].name,
    gate2.proofs[0].observedAt,
  );
  falseProofBytes.set(
    gate2.proofs[0].name,
    Buffer.from(canonicalJson({
      ...falseForward,
      measurements: { ...falseForward.measurements, priorOwnersReleased: false },
    })),
  );
  await assert.rejects(
    verifyStagingGateEvidence(
      withProofBytes(gate2, falseProofBytes),
      binding,
      gate2.actionId,
      {
        ...unusedGatePorts(async (_actionId: string, name: string) => falseProofBytes.get(name)!),
      },
    ),
    /measurement|contract|proof/i,
  );

  const gate4 = artifact("staging-gate-4-phase3");
  const gate4ProofBytes = new Map(gate4.proofs.map((proof) => [
    proof.name,
    Buffer.from(canonicalJson(proofDocument(gate4.actionId, proof.name, proof.observedAt))),
  ]));
  const boundGate4 = withProofBytes(gate4, gate4ProofBytes);
  const gate4Events: string[] = [];
  let semanticChecks = 0;
  const gate4Ports = {
    async readProof(_actionId: string, name: string) {
      gate4Events.push(`proof:${name}`);
      return gate4ProofBytes.get(name)!;
    },
    async readFixedPhase3SourceGraph() {
      gate4Events.push("fixed-source-graph");
      return fixedSourceGraph();
    },
    async verifyPhase3Semantic(input: { expectedSemanticSha256: string }) {
      gate4Events.push("semantic");
      semanticChecks += 1;
      assert.equal(input.expectedSemanticSha256, fixedSourceGraph()["phase3-semantic"].sha256);
      return { ok: true, failures: [] };
    },
    async loadLeases(actualStagingRunId: string) {
      gate4Events.push("leases");
      assert.equal(actualStagingRunId, stagingRunId);
      return liveLeases();
    },
  };
  assert.equal((await verifyStagingGateEvidence(
    boundGate4,
    binding,
    gate4.actionId,
    gate4Ports,
  )).ok, true);
  assert.equal(semanticChecks, 1);
  assert.deepEqual(gate4Events.slice(-3), ["fixed-source-graph", "semantic", "leases"]);

  const historicalEvents: string[] = [];
  assert.equal((await verifyHistoricalStagingGateEvidence(
    boundGate4,
    { ...binding, actionJournalHeadSha256: H("2") },
    gate4.actionId,
    {
      ...gate4Ports,
      async readFixedPhase3SourceGraph() {
        historicalEvents.push("fixed-source-graph");
        return fixedSourceGraph();
      },
      async verifyPhase3Semantic(input: { expectedSemanticSha256: string }) {
        historicalEvents.push("semantic");
        assert.equal(input.expectedSemanticSha256, fixedSourceGraph()["phase3-semantic"].sha256);
        return { ok: true, failures: [] };
      },
      async loadLeases() {
        throw new Error("historical verification must not require a closed live guard");
      },
    },
  )).ok, true);
  assert.deepEqual(historicalEvents, ["fixed-source-graph", "semantic"]);

  assert.equal((await verifyStagingGateEvidence(
    boundGate4,
    { ...binding, actionJournalHeadSha256: H("2") },
    gate4.actionId,
    gate4Ports,
  )).ok, true);
  assert.equal(semanticChecks, 2);

  const mismatchedBindingProofBytes = new Map(gate4ProofBytes);
  const mismatchedBindingName = gate4.proofs[0].name;
  const mismatchedBindingProof = JSON.parse(
    mismatchedBindingProofBytes.get(mismatchedBindingName)!.toString("utf8"),
  );
  mismatchedBindingProof.releaseBinding.actionJournalHeadSha256 = H("3");
  mismatchedBindingProofBytes.set(
    mismatchedBindingName,
    Buffer.from(canonicalJson(mismatchedBindingProof)),
  );
  await assert.rejects(
    verifyStagingGateEvidence(
      withProofBytes(gate4, mismatchedBindingProofBytes),
      { ...binding, actionJournalHeadSha256: H("2") },
      gate4.actionId,
      {
        ...gate4Ports,
        async readProof(_actionId: string, name: string) {
          return mismatchedBindingProofBytes.get(name)!;
        },
      },
    ),
    /binding|historical|aggregate|proof/i,
  );

  const forgedHistoricalHead = H("3");
  const coherentForgedProofBytes = new Map(gate4ProofBytes);
  for (const [name, bytes] of coherentForgedProofBytes) {
    const proof = JSON.parse(bytes.toString("utf8"));
    proof.releaseBinding.actionJournalHeadSha256 = forgedHistoricalHead;
    coherentForgedProofBytes.set(name, Buffer.from(canonicalJson(proof)));
  }
  const coherentForgedGate4 = withProofBytes({
    ...gate4,
    releaseBinding: { ...binding, actionJournalHeadSha256: forgedHistoricalHead },
  }, coherentForgedProofBytes);
  await assert.rejects(
    verifyStagingGateEvidence(
      coherentForgedGate4,
      { ...binding, actionJournalHeadSha256: H("2") },
      gate4.actionId,
      {
        ...gate4Ports,
        async readProof(_actionId: string, name: string) {
          return coherentForgedProofBytes.get(name)!;
        },
      },
    ),
    /binding|historical|snapshot|head/i,
  );

  for (const sourceId of [...PHASE3_SEMANTIC_SOURCE_IDS, "phase3-semantic"]) {
    let tamperedSemanticChecks = 0;
    const tamperedGraph = fixedSourceGraph();
    tamperedGraph[sourceId] = {
      ...tamperedGraph[sourceId],
      bytes: `${tamperedGraph[sourceId].bytes} `,
    };
    await assert.rejects(
      verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, {
        ...gate4Ports,
        async readFixedPhase3SourceGraph() { return tamperedGraph; },
        async verifyPhase3Semantic() {
          tamperedSemanticChecks += 1;
          return { ok: true, failures: [] };
        },
      }),
      /source|hash|canonical|evidence/i,
    );
    assert.equal(tamperedSemanticChecks, 0);
  }

  const alteredProofBytes = new Map(gate4ProofBytes);
  const alteredName = gate4.proofs[0].name;
  const alteredProof = JSON.parse(alteredProofBytes.get(alteredName)!.toString("utf8"));
  alteredProof.sourceEvidence[0].id = "phase3-semantic";
  alteredProofBytes.set(alteredName, Buffer.from(canonicalJson(alteredProof)));
  await assert.rejects(
    verifyStagingGateEvidence(
      withProofBytes(gate4, alteredProofBytes),
      binding,
      gate4.actionId,
      { ...gate4Ports, async readProof(_actionId: string, name: string) { return alteredProofBytes.get(name)!; } },
    ),
    /source|contract|proof/i,
  );

  await assert.rejects(
    verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, {
      ...gate4Ports,
      async loadLeases() {
        return liveLeases({
          guard: {
            ...liveLeases().guard,
            leaseId: "33333333-3333-4333-8333-333333333333",
          },
        });
      },
    }),
    /lease|continuity|instance/i,
  );
  await assert.rejects(
    verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, {
      ...gate4Ports,
      async loadLeases() {
        return liveLeases({
          guard: {
            ...liveLeases().guard,
            baselineP95LatencyMs: 26,
          },
        });
      },
    }),
    /lease|continuity|baseline/i,
  );
  await assert.rejects(
    verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, {
      ...gate4Ports,
      async loadLeases() {
        return liveLeases({
          guard: {
            ...liveLeases().guard,
            heartbeatMonotonicMs: 8_999,
            heartbeatAgeMs: 500,
          },
        });
      },
    }),
    /lease|continuity|heartbeat/i,
  );
  let expiredHandlerAppendedSuccess = false;
  await assert.rejects(
    (async () => {
      await verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, {
        ...gate4Ports,
        async loadLeases() {
          return liveLeases({
            watchdog: {
              ...liveLeases().watchdog,
              heartbeatAgeMs: 10_001,
            },
          });
        },
      });
      expiredHandlerAppendedSuccess = true;
    })(),
    /fresh|lease|watchdog/i,
  );
  assert.equal(expiredHandlerAppendedSuccess, false);

  await assert.rejects(
    verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, {
      readProof: gate4Ports.readProof,
    } as never),
    /port|complete|fixed|function/i,
  );
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      verifyStagingGateEvidence(boundGate4, binding, gate4.actionId, gate4Ports),
      /test|port|caller|forbidden/i,
    );
  } finally {
    process.env.NODE_ENV = savedNodeEnv;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
