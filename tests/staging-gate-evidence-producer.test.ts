import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
} from "../scripts/lib/phase3-staging-evidence.mjs";
import {
  STAGING_GATE_PROOF_CONTRACTS,
  PHASE3_GATE4_SOURCE_GRAPH,
  producePhase3Gate4Proofs,
  produceStagingGateEvidence,
  validateStagingGateProof,
  writeStagingGateProof,
} from "../scripts/lib/staging-gate-evidence.mjs";
import {
  STAGING_GATE_ACTIONS,
  verifyStagingGateEvidence,
} from "../scripts/staging-gate-evidence-check.mjs";

const binding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "c".repeat(64),
  environment: "staging",
  topology: "split",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: "d".repeat(64),
  operatorBundleSha256: "e".repeat(64),
  stagingApprovalEnvelopeSha256: "f".repeat(64),
  actionJournalHeadSha256: "1".repeat(64),
  stagingRunId: "staging-run-001",
};
const nowMs = Date.now();
const observedAt = new Date(nowMs - 120_000).toISOString();
const capturedAt = new Date(nowMs - 60_000).toISOString();
const expectedSourceActionIds = {
  "staging-gate-1-baseline": {
    "release-binding": ["staging-gate-1-baseline"],
    "runtime-identities": ["staging-runtime-start"],
    "guard-continuity": ["staging-gate-1-baseline"],
    "staging-database": ["staging-gate-1-baseline", "staging-db-bootstrap-revoke"],
    "production-unchanged": ["staging-gate-1-baseline"],
  },
  "staging-gate-2-worker": {
    "worker-forward": ["staging-worker-forward-handoff"],
    "worker-reverse": ["staging-worker-reverse-handoff"],
    "lease-fencing": ["staging-gate-2-worker"],
    "watermark-monotonic": ["staging-gate-2-worker"],
    "guard-continuity": ["staging-gate-2-worker"],
    "production-unchanged": ["staging-gate-2-worker"],
  },
  "staging-gate-3-handoff": {
    "gate-1-handoff": ["staging-gate-1-baseline"],
    "gate-2-handoff": ["staging-gate-2-worker"],
    "gate-3-handoff": ["staging-gate-3-handoff"],
    "release-binding": ["staging-gate-3-handoff"],
    "guard-continuity": ["staging-gate-3-handoff"],
    "production-unchanged": ["staging-gate-3-handoff"],
  },
  "staging-gate-4-phase3": {
    "schema-verify": ["phase3-schema-verify"],
    "consumer-start-disabled": ["phase3-consumer-start-disabled"],
    "legacy-lease-release": ["phase3-legacy-lease-release"],
    "poller-start": ["phase3-poller-start"],
    "publication-enable": ["phase3-publication-enable"],
    "execution-enable": ["phase3-execution-enable"],
    "publication-fence": ["phase3-publication-fence"],
    "fence-acknowledged": ["phase3-fence-ack-wait"],
    "drain-or-quarantine": ["phase3-drain-or-quarantine"],
    "inline-owner-restore": ["phase3-inline-owner-restore"],
    "baseline-restored": ["phase3-inline-owner-restore"],
    "phase3-durable-evidence": ["phase3-inline-owner-restore"],
    "release-binding": ["phase3-inline-owner-restore"],
    "guard-continuity": ["phase3-inline-owner-restore"],
    "production-unchanged": ["phase3-inline-owner-restore"],
  },
};

const expectedGate4SourceGraph = {
  "schema-verify": ["phase3-schema-marker"],
  "consumer-start-disabled": ["phase3-action:phase3-consumer-start-disabled"],
  "legacy-lease-release": ["phase3-action:phase3-legacy-lease-release"],
  "poller-start": ["phase3-action:phase3-poller-start"],
  "publication-enable": ["phase3-action:phase3-publication-enable"],
  "execution-enable": ["phase3-action:phase3-execution-enable"],
  "publication-fence": ["phase3-action:phase3-publication-fence"],
  "fence-acknowledged": ["phase3-fence-marker"],
  "drain-or-quarantine": [
    "phase3-action:phase3-drain-or-quarantine",
    "phase3-db-final",
  ],
  "inline-owner-restore": ["phase3-action:phase3-inline-owner-restore"],
  "baseline-restored": ["phase3-runtime-final"],
  "phase3-durable-evidence": [
    "phase3-journal-snapshot",
    "phase3-schema-marker",
    "phase3-fence-marker",
    ...PHASE3_ACTION_IDS.map((actionId) => `phase3-action:${actionId}`),
    "phase3-semantic",
  ],
  "release-binding": ["phase3-journal-snapshot", "phase3-schema-marker"],
  "guard-continuity": ["phase3-lease-continuity"],
  "production-unchanged": ["phase3-production-observer", "phase3-capacity"],
};

const task4SourceHashes = Object.freeze(Object.fromEntries(
  PHASE3_SEMANTIC_SOURCE_IDS.map((sourceId, index) => [
    sourceId,
    createHash("sha256").update(`task-4-source:${index}:${sourceId}`).digest("hex"),
  ]),
));
const semanticValue = { schemaVersion: 2, evidenceId: "phase3-test-semantic" };
const semanticBytes = canonicalJson(semanticValue);
const semanticSha256 = createHash("sha256").update(semanticBytes).digest("hex");
const semantic = Object.freeze({
  value: semanticValue,
  bytes: semanticBytes,
  sha256: semanticSha256,
});

function proofValue(
  gateActionId: string,
  proofName: string,
  overrides: Record<string, unknown> = {},
) {
  const contract = STAGING_GATE_PROOF_CONTRACTS[gateActionId][proofName];
  return {
    schemaVersion: 1,
    gateActionId,
    proofName,
    sourceActionId: contract.sourceActionIds[0],
    observedAt,
    releaseBinding: binding,
    measurements: contract.measurements,
    ...overrides,
  };
}

function writeInput(gateActionId: string, proofName: string, overrides = {}) {
  const value = proofValue(gateActionId, proofName, overrides);
  const { releaseBinding, schemaVersion: _schemaVersion, ...proof } = value;
  return { ...proof, binding: releaseBinding };
}

async function writeGateProofs(gateActionId: string, root: string, expectedUid: number | null) {
  for (const proofName of Object.keys(STAGING_GATE_PROOF_CONTRACTS[gateActionId])) {
    await writeStagingGateProof(writeInput(gateActionId, proofName), {
      root,
      expectedUid,
      nowMs,
    });
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "spx-gate-producer-"));
  const expectedUid = process.platform === "win32" ? null : process.getuid!();
  try {
    if (process.platform !== "win32") await chmod(root, 0o700);

    assert.deepEqual(PHASE3_SEMANTIC_SOURCE_IDS, [
      "phase3-journal-snapshot",
      "phase3-schema-marker",
      "phase3-fence-marker",
      ...PHASE3_ACTION_IDS.map((actionId) => `phase3-action:${actionId}`),
      "phase3-db-final",
      "phase3-runtime-final",
      "phase3-lease-continuity",
      "phase3-capacity",
      "phase3-production-observer",
    ]);
    assert.equal(PHASE3_SEMANTIC_SOURCE_IDS.includes("phase3-semantic"), false);
    assert.deepEqual(PHASE3_GATE4_SOURCE_GRAPH, expectedGate4SourceGraph);
    const graphUnion = new Set(Object.values(PHASE3_GATE4_SOURCE_GRAPH).flat());
    graphUnion.delete("phase3-semantic");
    assert.deepEqual([...graphUnion].sort(), [...PHASE3_SEMANTIC_SOURCE_IDS].sort());

    assert.deepEqual(
      Object.keys(STAGING_GATE_PROOF_CONTRACTS),
      STAGING_GATE_ACTIONS.map(({ actionId }) => actionId),
    );
    for (const action of STAGING_GATE_ACTIONS) {
      assert.deepEqual(
        Object.keys(STAGING_GATE_PROOF_CONTRACTS[action.actionId]),
        [...action.requiredProofs],
      );
      assert.deepEqual(
        Object.fromEntries(Object.entries(STAGING_GATE_PROOF_CONTRACTS[action.actionId])
          .map(([name, contract]) => [name, contract.sourceActionIds])),
        expectedSourceActionIds[action.actionId as keyof typeof expectedSourceActionIds],
      );
      let evidence;
      if (action.actionId === "staging-gate-4-phase3") {
        let proofWrites = 0;
        let aggregateWrites = 0;
        const producerPorts = {
          async writeProof(input: Record<string, unknown>) {
            proofWrites += 1;
            return writeStagingGateProof(input as never, { root, expectedUid, nowMs });
          },
          async writeAggregate(input: Record<string, unknown>) {
            aggregateWrites += 1;
            return produceStagingGateEvidence(input as never, { root, expectedUid, nowMs });
          },
        };
        evidence = await producePhase3Gate4Proofs({
          semantic,
          semanticSha256,
          sources: task4SourceHashes,
          binding,
          capturedAt,
        }, producerPorts);
        assert.equal(proofWrites, 15);
        assert.equal(aggregateWrites, 1);
        assert.equal(evidence.schemaVersion, 1);
        assert.deepEqual(Object.keys(evidence), [
          "actionId",
          "capturedAt",
          "gate",
          "proofs",
          "releaseBinding",
          "schemaVersion",
          "stagingRunId",
        ]);
        assert.deepEqual(
          await producePhase3Gate4Proofs({
            semantic,
            semanticSha256,
            sources: task4SourceHashes,
            binding,
            capturedAt,
          }, producerPorts),
          evidence,
        );
        assert.equal(proofWrites, 30);
        assert.equal(aggregateWrites, 2);
        for (const proof of evidence.proofs) {
          const value = JSON.parse(await readFile(
            join(root, "proofs", action.actionId, `${proof.name}.json`),
            "utf8",
          ));
          assert.equal(value.schemaVersion, 2);
          assert.equal(value.sourceActionId, expectedSourceActionIds[action.actionId][proof.name][0]);
          assert.notEqual(value.sourceActionId, "staging-gate-4-phase3");
          assert.deepEqual(
            value.sourceEvidence,
            expectedGate4SourceGraph[proof.name as keyof typeof expectedGate4SourceGraph]
              .map((id) => ({
                id,
                sha256: id === "phase3-semantic"
                  ? semanticSha256
                  : task4SourceHashes[id],
              })),
          );
        }
      } else {
        await writeGateProofs(action.actionId, root, expectedUid);
        evidence = await produceStagingGateEvidence({
          gateActionId: action.actionId,
          binding,
          capturedAt,
        }, { root, expectedUid, nowMs });
        assert.deepEqual(
          await produceStagingGateEvidence({
            gateActionId: action.actionId,
            binding,
            capturedAt,
          }, { root, expectedUid, nowMs }),
          evidence,
        );
      }
      assert.deepEqual(
        evidence.proofs.map((proof: { name: string }) => proof.name),
        [...action.requiredProofs],
      );
      if (action.actionId !== "staging-gate-4-phase3") {
        assert.equal(evidence.schemaVersion, 1);
        assert.deepEqual(Object.keys(evidence), [
          "actionId",
          "capturedAt",
          "gate",
          "proofs",
          "releaseBinding",
          "schemaVersion",
          "stagingRunId",
        ]);
        for (const proofName of action.requiredProofs) {
          const proofValue = JSON.parse(await readFile(
            join(root, "proofs", action.actionId, `${proofName}.json`),
            "utf8",
          ));
          assert.equal(proofValue.schemaVersion, 1);
          assert.deepEqual(Object.keys(proofValue), [
            "gateActionId",
            "measurements",
            "observedAt",
            "proofName",
            "releaseBinding",
            "schemaVersion",
            "sourceActionId",
          ]);
          assert.equal("sourceEvidence" in proofValue, false);
        }
        assert.equal((await verifyStagingGateEvidence(evidence, binding, action.actionId, {
          readProof: async (actionId: string, name: string) =>
            readFile(join(root, "proofs", actionId, `${name}.json`)),
          async readFixedPhase3SourceGraph() { throw new Error("not Gate 4"); },
          async verifyPhase3Semantic() { throw new Error("not Gate 4"); },
          async loadLeases() { throw new Error("not Gate 4"); },
        })).ok, true);
      }
      const aggregateBytes = await readFile(join(root, `${action.gate}.json`), "utf8");
      assert.equal(aggregateBytes, canonicalJson(JSON.parse(aggregateBytes)));
    }

    for (const gateActionId of Object.keys(STAGING_GATE_PROOF_CONTRACTS)) {
      assert.deepEqual(
        STAGING_GATE_PROOF_CONTRACTS[gateActionId]["guard-continuity"].measurements,
        { continuityGapMs: 0, guardFresh: true, watchdogFresh: true },
      );
      assert.deepEqual(
        STAGING_GATE_PROOF_CONTRACTS[gateActionId]["production-unchanged"].measurements,
        {
          productionDatabaseConnectivityUnchanged: true,
          productionReadinessUnchanged: true,
        },
      );
    }
    assert.equal(
      STAGING_GATE_PROOF_CONTRACTS["staging-gate-1-baseline"]["release-binding"]
        .measurements.releaseIdentityMatches,
      true,
    );
    assert.equal(
      STAGING_GATE_PROOF_CONTRACTS["staging-gate-2-worker"]["watermark-monotonic"]
        .measurements.watermarkRegressionCount,
      0,
    );
    assert.deepEqual(
      STAGING_GATE_PROOF_CONTRACTS["staging-gate-3-handoff"]["gate-3-handoff"]
        .measurements,
      {
        gate1EvidenceBound: true,
        gate2EvidenceBound: true,
        phase3MutationCount: 0,
      },
    );
    assert.deepEqual(
      STAGING_GATE_PROOF_CONTRACTS["staging-gate-4-phase3"]["phase3-durable-evidence"]
        .measurements,
      { durableMutationProofCount: 8, missingProofCount: 0, readOnlyObservationCount: 2 },
    );
    assert.equal(
      "n-minus-one-compatible" in STAGING_GATE_PROOF_CONTRACTS["staging-gate-4-phase3"],
      false,
    );

    await assert.rejects(
      produceStagingGateEvidence({
        gateActionId: "staging-gate-2-worker",
        binding,
        capturedAt: new Date(nowMs - 30_000).toISOString(),
      }, { root, expectedUid, nowMs }),
      /conflict|existing/i,
    );

    const gateActionId = "staging-gate-2-worker";
    const proofName = "worker-forward";
    const validProof = proofValue(gateActionId, proofName);
    const temporalInversionRoot = join(root, "temporal-inversion");
    await writeGateProofs(gateActionId, temporalInversionRoot, expectedUid);
    await assert.rejects(
      produceStagingGateEvidence({
        gateActionId,
        binding,
        capturedAt: new Date(Date.parse(observedAt) - 6 * 60_000).toISOString(),
      }, { root: temporalInversionRoot, expectedUid, nowMs }),
      /capture|causal|observation|temporal/i,
    );

    assert.throws(
      () => validateStagingGateProof(
        { ...validProof, sourceActionId: "caller-selected-action" },
        binding,
        gateActionId,
        proofName,
        { nowMs },
      ),
      /source|contract|proof/i,
    );
    assert.throws(
      () => validateStagingGateProof(
        {
          ...validProof,
          measurements: { ...validProof.measurements, priorOwnersReleased: false },
        },
        binding,
        gateActionId,
        proofName,
        { nowMs },
      ),
      /measurement|contract|proof/i,
    );
    const { priorOwnersReleased: _missing, ...missingMeasurement } = validProof.measurements;
    assert.throws(
      () => validateStagingGateProof(
        { ...validProof, measurements: missingMeasurement },
        binding,
        gateActionId,
        proofName,
        { nowMs },
      ),
      /measurement|contract|proof/i,
    );
    assert.throws(
      () => validateStagingGateProof(
        { ...validProof, measurements: { ...validProof.measurements, unexpectedCount: 0 } },
        binding,
        gateActionId,
        proofName,
        { nowMs },
      ),
      /measurement|contract|proof/i,
    );
    assert.throws(
      () => validateStagingGateProof(
        { ...validProof, measurements: { ...validProof.measurements, activeOwnerCount: Infinity } },
        binding,
        gateActionId,
        proofName,
        { nowMs },
      ),
      /finite|measurement|canonical/i,
    );
    assert.throws(
      () => validateStagingGateProof(
        validProof,
        { ...binding, stagingRunId: "staging-run-002" },
        gateActionId,
        proofName,
        { nowMs },
      ),
      /binding|run/i,
    );

    const rewriteRoot = join(root, "rewrite");
    const first = await writeStagingGateProof(writeInput(gateActionId, proofName), {
      root: rewriteRoot,
      expectedUid,
      nowMs,
    });
    assert.deepEqual(
      await writeStagingGateProof(writeInput(gateActionId, proofName), {
        root: rewriteRoot,
        expectedUid,
        nowMs,
      }),
      first,
    );
    await assert.rejects(
      writeStagingGateProof(
        writeInput(gateActionId, proofName, { observedAt: new Date(nowMs - 90_000).toISOString() }),
        { root: rewriteRoot, expectedUid, nowMs },
      ),
      /conflict|existing/i,
    );

    const concurrentRoot = join(root, "concurrent");
    const concurrent = await Promise.allSettled([
      writeStagingGateProof(writeInput(gateActionId, proofName), {
        root: concurrentRoot,
        expectedUid,
        nowMs,
      }),
      writeStagingGateProof(
        writeInput(gateActionId, proofName, { observedAt: new Date(nowMs - 90_000).toISOString() }),
        { root: concurrentRoot, expectedUid, nowMs },
      ),
    ]);
    assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(({ status }) => status === "rejected").length, 1);

    await assert.rejects(
      produceStagingGateEvidence({
        gateActionId,
        binding,
        capturedAt,
        proofs: [],
      } as never, { root, expectedUid, nowMs }),
      /input|proof|caller/i,
    );

    let rejectedWrites = 0;
    await assert.rejects(
      producePhase3Gate4Proofs({
        semantic: { ...semantic, bytes: `${semantic.bytes}\n` },
        semanticSha256,
        sources: task4SourceHashes,
        binding,
        capturedAt,
      }, {
        async writeProof() { rejectedWrites += 1; },
        async writeAggregate() { rejectedWrites += 1; },
      }),
      /semantic|hash|canonical|proof/i,
    );
    assert.equal(rejectedWrites, 0);
    await assert.rejects(
      producePhase3Gate4Proofs({
        semantic,
        semanticSha256,
        sources: task4SourceHashes,
        binding,
        capturedAt,
      }, { async writeProof() {} } as never),
      /port|complete|function|proof/i,
    );
    await assert.rejects(
      producePhase3Gate4Proofs({
        semantic,
        semanticSha256,
        sources: Object.fromEntries(Object.entries(task4SourceHashes).reverse()),
        binding,
        capturedAt,
      }, {
        async writeProof() {},
        async writeAggregate() {},
      }),
      /source|graph|order|proof/i,
    );
    await assert.rejects(
      producePhase3Gate4Proofs({
        semantic,
        semanticSha256,
        sources: task4SourceHashes,
        binding,
        capturedAt,
        sourceIds: ["caller-selected"],
      } as never, {
        async writeProof() {},
        async writeAggregate() {},
      }),
      /input|field|contract|proof/i,
    );
    const producerNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        producePhase3Gate4Proofs({
          semantic,
          semanticSha256,
          sources: task4SourceHashes,
          binding,
          capturedAt,
        }, {
          async writeProof() {},
          async writeAggregate() {},
        }),
        /test|port|caller|forbidden/i,
      );
    } finally {
      process.env.NODE_ENV = producerNodeEnv;
    }

    if (process.platform !== "win32") {
      const hardenedRoot = join(root, "created-directory-modes");
      const previousUmask = process.umask(0o777);
      try {
        await writeStagingGateProof(writeInput(gateActionId, proofName), {
          root: hardenedRoot,
          expectedUid,
          nowMs,
        });
      } finally {
        process.umask(previousUmask);
      }
      for (const directory of [
        hardenedRoot,
        join(hardenedRoot, "proofs"),
        join(hardenedRoot, "proofs", gateActionId),
      ]) {
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
      }

      const symlinkRoot = join(root, "symlink");
      const proofDirectory = join(symlinkRoot, "proofs", gateActionId);
      await mkdir(symlinkRoot, { mode: 0o700 });
      await mkdir(join(symlinkRoot, "proofs"), { mode: 0o700 });
      await mkdir(proofDirectory, { mode: 0o700 });
      const target = join(root, "symlink-target.json");
      await writeFile(target, canonicalJson(validProof), { mode: 0o600 });
      await symlink(target, join(proofDirectory, `${proofName}.json`));
      await assert.rejects(
        writeStagingGateProof(writeInput(gateActionId, proofName), {
          root: symlinkRoot,
          expectedUid,
          nowMs,
        }),
        /symlink|regular|secure/i,
      );

      const insecureRoot = join(root, "insecure");
      await mkdir(insecureRoot, { mode: 0o770 });
      await chmod(insecureRoot, 0o770);
      await assert.rejects(
        writeStagingGateProof(writeInput(gateActionId, proofName), {
          root: insecureRoot,
          expectedUid,
          nowMs,
        }),
        /directory|permission|writable|secure/i,
      );

      const insecureFileRoot = join(root, "insecure-file");
      await writeGateProofs(gateActionId, insecureFileRoot, expectedUid);
      await chmod(
        join(insecureFileRoot, "proofs", gateActionId, `${proofName}.json`),
        0o640,
      );
      await assert.rejects(
        produceStagingGateEvidence({ gateActionId, binding, capturedAt }, {
          root: insecureFileRoot,
          expectedUid,
          nowMs,
        }),
        /file|permission|mode|secure/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
