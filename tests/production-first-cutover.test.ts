import assert from "node:assert/strict";

import {
  executeFirstProductionCutover,
  validateFirstCutoverApproval,
} from "../scripts/production-first-cutover.mjs";

const RELEASE_SHA = "1".repeat(40);
const IMAGE_DIGEST = `sha256:${"2".repeat(64)}`;
const H = (value: string) => value.repeat(64).slice(0, 64);
const NOW = Date.parse("2026-09-16T00:00:00.000Z");

function approval(unit: "primary" | "team2" = "primary") {
  return {
    schemaVersion: 1,
    operationId: `first-cutover-${unit}-001`,
    deploymentUnit: unit,
    releaseSha: RELEASE_SHA,
    imageRef: `spx-app:${RELEASE_SHA}`,
    imageDigest: IMAGE_DIGEST,
    descriptorArtifactSha256: H("3"),
    identityApprovalSha256: H("4"),
    backupEvidenceSha256: H("5"),
    legacy: unit === "primary"
      ? {
          project: "spx",
          services: ["notifier", "worker-ptwl"],
          teamOwners: { "1": "prod-worker-ptwl-1" },
          snapshotSha256: H("6"),
        }
      : {
          project: "spx",
          services: ["worker-ifn"],
          teamOwners: { "2": "prod-worker-ifn-node2" },
          snapshotSha256: H("7"),
        },
    candidate: unit === "primary"
      ? {
          project: "spx-production",
          services: [
            "line-service",
            "notification-service",
            "ocr-service",
            "web-api",
            "worker-ptwl-split",
          ],
          teamOwners: { "1": "prod-worker-ptwl-split-1" },
          publishedPorts: ["127.0.0.1:3000:3000/tcp"],
          configSha256: H("8"),
        }
      : {
          project: "spx-production",
          services: ["worker-ifn-split"],
          teamOwners: { "2": "prod-worker-ifn-node2" },
          publishedPorts: [],
          configSha256: H("9"),
        },
    maintenanceWindow: {
      notBefore: "2026-09-15T23:55:00.000Z",
      notAfter: "2026-09-16T00:30:00.000Z",
    },
    healthTimeoutMs: 300_000,
    rollbackOwner: "on-call-primary",
  } as const;
}

function adapter(options: { failHealth?: boolean; failCommit?: boolean } = {}) {
  const calls: string[] = [];
  let legacyRunning = true;
  let candidateRunning = false;
  return {
    calls,
    port: {
      async inspectLegacy() {
        calls.push("inspect-legacy");
        return { snapshotSha256: H("6"), running: legacyRunning };
      },
      async inspectCandidate() {
        calls.push("inspect-candidate");
        return { running: candidateRunning };
      },
      async writeJournal({ state }: { state: string }) { calls.push(`journal:${state}`); },
      async stopLegacy() { calls.push("stop-legacy"); legacyRunning = false; },
      async assertLegacyStopped() { calls.push("legacy-stopped"); return !legacyRunning; },
      async startCandidate() { calls.push("start-candidate"); candidateRunning = true; },
      async waitCandidateHealthy() {
        calls.push("candidate-healthy");
        return !options.failHealth && candidateRunning;
      },
      async verifyCandidate() { calls.push("verify-candidate"); return candidateRunning; },
      async commitProjection() {
        calls.push("commit-projection");
        if (options.failCommit) throw new Error("commit failed");
      },
      async stopCandidate() { calls.push("stop-candidate"); candidateRunning = false; },
      async startLegacy() { calls.push("start-legacy"); legacyRunning = true; },
      async verifyLegacy() { calls.push("verify-legacy"); return legacyRunning; },
    },
  };
}

async function main(): Promise<void> {
  assert.equal(validateFirstCutoverApproval(approval(), NOW).deploymentUnit, "primary");
  assert.equal(validateFirstCutoverApproval(approval("team2"), NOW).deploymentUnit, "team2");

  const badTeam2 = structuredClone(approval("team2"));
  badTeam2.candidate.publishedPorts.push("0.0.0.0:3000:3000/tcp" as never);
  assert.throws(() => validateFirstCutoverApproval(badTeam2, NOW), /TEAM 2.*port/i);

  const duplicateTeam = structuredClone(approval());
  duplicateTeam.candidate.teamOwners["2" as never] = "wrong-node" as never;
  assert.throws(() => validateFirstCutoverApproval(duplicateTeam, NOW), /team owner/i);

  const wrongOwner = structuredClone(approval());
  wrongOwner.candidate.teamOwners["1"] = "wrong-node";
  assert.throws(() => validateFirstCutoverApproval(wrongOwner, NOW), /team owner/i);

  const success = adapter();
  const result = await executeFirstProductionCutover({
    approval: approval(),
    now: () => NOW,
    adapter: success.port,
  });
  assert.equal(result.status, "committed");
  assert.deepEqual(success.calls, [
    "inspect-legacy",
    "inspect-candidate",
    "journal:prepared",
    "stop-legacy",
    "legacy-stopped",
    "journal:legacy-stopped",
    "start-candidate",
    "journal:candidate-started",
    "candidate-healthy",
    "verify-candidate",
    "journal:healthy",
    "commit-projection",
    "journal:committed",
  ]);

  const failed = adapter({ failHealth: true });
  await assert.rejects(
    executeFirstProductionCutover({
      approval: approval(),
      now: () => NOW,
      adapter: failed.port,
    }),
    /rolled back/i,
  );
  assert.deepEqual(failed.calls.slice(-6), [
    "journal:rolling-back",
    "stop-candidate",
    "start-legacy",
    "verify-legacy",
    "journal:rolled-back",
    "inspect-legacy",
  ]);

  const commitFailed = adapter({ failCommit: true });
  await assert.rejects(
    executeFirstProductionCutover({
      approval: approval(),
      now: () => NOW,
      adapter: commitFailed.port,
    }),
    /rolled back/i,
  );
  assert.ok(commitFailed.calls.includes("stop-candidate"));
  assert.ok(commitFailed.calls.includes("start-legacy"));

  console.log("production first cutover tests passed");
}

void main();
