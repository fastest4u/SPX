import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertProtectedEvidenceFileSet,
  producerFor,
} from "../scripts/lib/protected-evidence-producers.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";

const KINDS = [
  "staging-gates",
  "production-backup-restore",
  "protected-install",
  "accepted-db-transition",
  "accepted-pre-close",
  "final-verifier",
] as const;

function producer(kind: (typeof KINDS)[number]) {
  const mapped = producerFor(kind);
  return {
    repository: "fastest4u/SPX",
    environment: mapped.environment,
    workflow: mapped.workflow,
    workflowSha: mapped.signerSha,
    workflowFileSha256: mapped.workflowFileSha256,
  };
}

async function writeStaging(value: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "spx-redaction-"));
  await writeFile(
    join(root, "staging-protected-evidence.json"),
    canonicalJson({ schemaVersion: 1, producer: producer("staging-gates"), ...value }),
  );
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeExporterOutput(kind: (typeof KINDS)[number], extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "spx-redaction-output-"));
  const mapped = producerFor(kind);
  const core = {
    schemaVersion: 1,
    candidateSha: "a".repeat(40),
    targetDescriptorSha256: "b".repeat(64),
    payloadSha256: "c".repeat(64),
    bootstrapPrincipalEvidenceSha256: "d".repeat(64),
    producer: producer(kind),
    ...extra,
  };
  if (mapped.files.length === 1) {
    await writeFile(join(root, mapped.files[0]), canonicalJson(core));
  } else {
    const signature = {
      schemaVersion: 1,
      algorithm: "kms-sha256",
      keyId: `spx-${kind}-evidence-v1`,
      subjectSha256: sha256Canonical(core),
      signatureBase64: Buffer.from("synthetic protected evidence signature").toString("base64"),
      signedAt: "2026-07-16T01:00:00.000Z",
    };
    await writeFile(
      join(root, mapped.files[0]),
      canonicalJson({ ...core, signatureSha256: sha256Canonical(signature) }),
    );
    await writeFile(join(root, mapped.files[1]), canonicalJson(signature));
  }
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeProtectedInstallOutput() {
  const root = await mkdtemp(join(tmpdir(), "spx-redaction-protected-install-"));
  const core = {
    schemaVersion: 1,
    releaseEnvironment: "production",
    operationId: "operation-2026-07-16",
    candidateSha: "a".repeat(40),
    candidateImageDigest: `sha256:${"b".repeat(64)}`,
    rollbackSha: "c".repeat(40),
    rollbackImageDigest: `sha256:${"d".repeat(64)}`,
    releaseManifestSha256: "e".repeat(64),
    rollbackReleaseManifestSha256: "f".repeat(64),
    productionTargetDescriptorSha256: "1".repeat(64),
    releaseOperatorBundleSha256: "2".repeat(64),
    installedOperatorBundleSha256: "3".repeat(64),
    databaseFingerprint: `sha256:${"4".repeat(64)}`,
    beforeSchema: 1,
    afterSchema: 2,
    installedMigrationSetSha256: "5".repeat(64),
    pendingReleasedMigrationCount: 0,
    backupRestoreEvidenceSha256: "6".repeat(64),
    backupSha256: "7".repeat(64),
    onlineDdl: [
      {
        migration: "001_create_booking_requests.sql",
        migrationSha256: "8".repeat(64),
        tableSizeBucket: "small",
        algorithm: "INSTANT",
        lock: "NONE",
        implicitFallback: false,
        durationMs: 120,
        maximumDurationMs: 1_000,
        headroomMs: 880,
        latencyBudgetPassed: true,
        ioBudgetPassed: true,
        connectionBudgetPassed: true,
        rehearsalMysqlVersion: "8.4.0",
        budgetsPassed: true,
      },
    ],
    activatedServices: [
      "web-api",
      "notification-service",
      "line-service",
      "ocr-service",
      "worker-ifn-split",
      "worker-ptwl-split",
    ],
    serviceActivationJournalSha256: "9".repeat(64),
    positiveGrantProofSha256: "a".repeat(64),
    forbiddenGrantProofSha256: "b".repeat(64),
    bootstrapPrincipalEvidenceSha256: "c".repeat(64),
    hostLock: {
      operationId: "operation-2026-07-16",
      state: "installed-awaiting-gate6",
      version: 1,
    },
    databaseSlot: {
      operationId: "operation-2026-07-16",
      state: "installed-awaiting-gate6",
      version: 1,
    },
    watchdog: {
      journalSha256: "d".repeat(64),
      startedAt: "2026-07-16T01:00:00.000Z",
      firstMutationAt: "2026-07-16T01:00:01.000Z",
      lastHeartbeatAt: "2026-07-16T01:00:02.000Z",
      finalizedAt: "2026-07-16T01:00:03.000Z",
      startedBeforeMutation: true,
      continuous: true,
      terminal: true,
    },
    healthEvidenceSha256: "e".repeat(64),
    watermarkEvidenceSha256: "f".repeat(64),
    rollbackReadinessSha256: "1".repeat(64),
    finalLease: {
      heartbeatAt: "2026-07-16T01:00:02.000Z",
      expiresAt: "2026-07-16T01:05:02.000Z",
    },
    issuedAt: "2026-07-16T01:00:03.000Z",
    producer: producer("protected-install"),
  };
  const signature = {
    schemaVersion: 1,
    algorithm: "kms-sha256",
    keyId: "spx-protected-install-evidence-v1",
    subjectSha256: sha256Canonical(core),
    signatureBase64: Buffer.from("synthetic protected install evidence signature").toString(
      "base64",
    ),
    signedAt: "2026-07-16T01:00:03.000Z",
  };
  await writeFile(
    join(root, "protected-install-evidence.json"),
    canonicalJson({ ...core, signatureSha256: sha256Canonical(signature) }),
  );
  await writeFile(join(root, "protected-install-signature.json"), canonicalJson(signature));
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("accepts hash-only outputs from all six exporters without reading secret sources", async () => {
  for (const kind of KINDS) {
    const fixture = await writeExporterOutput(kind);
    try {
      const result = await assertProtectedEvidenceFileSet(kind, fixture.root);
      assert.equal(result.files.length, producerFor(kind).files.length);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("rejects raw SQL injected into schema-shaped outputs from every protected evidence kind", async () => {
  for (const kind of KINDS) {
    const fixture = await writeExporterOutput(kind, { diagnosticNotice: "SHOW TABLES" });
    try {
      await assert.rejects(
        assertProtectedEvidenceFileSet(kind, fixture.root),
        /unsafe redacted content|fields are invalid|file set/i,
        `${kind} must reject raw SQL in exporter output`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("accepts schema-shaped protected-install MySQL rehearsal metadata", async () => {
  const fixture = await writeProtectedInstallOutput();
  try {
    const result = await assertProtectedEvidenceFileSet("protected-install", fixture.root);
    assert.equal(
      result.files[0].value.onlineDdl[0].rehearsalMysqlVersion,
      "8.4.0",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects secret-shaped keys and values used by evidence-artifact scanning", async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["password key", { password: "synthetic-value" }],
    ["credential key", { apiCredential: "synthetic-value" }],
    ["authorization value", { diagnostic: "Bearer synthetic-token-value" }],
    ["private key", { diagnostic: "-----BEGIN PRIVATE KEY-----" }],
    ["provider key", { diagnostic: "sk-synthetic_not_a_real_key_123456789" }],
  ];
  for (const [name, value] of cases) {
    await t.test(name, async () => {
      const fixture = await writeStaging(value);
      try {
        await assert.rejects(
          assertProtectedEvidenceFileSet("staging-gates", fixture.root),
          /secret|redact|unsafe/i,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("rejects raw SQL, endpoints, env/file contents, diagnostic text, and account identities", async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["raw SQL key", { rawSql: "synthetic statement" }],
    ["raw SQL text", { diagnostic: "SELECT synthetic_column FROM synthetic_table" }],
    ["raw SQL SHOW", { diagnostic: "SHOW TABLES" }],
    ["raw SQL DESCRIBE", { diagnostic: "DESCRIBE synthetic_table" }],
    ["raw SQL DESC", { diagnostic: "DESC synthetic_table" }],
    ["raw SQL EXPLAIN", { diagnostic: "EXPLAIN synthetic_query" }],
    ["raw SQL CALL", { diagnostic: "CALL synthetic_procedure" }],
    ["raw SQL SET", { diagnostic: "SET synthetic_flag = 1" }],
    ["raw SQL USE", { diagnostic: "USE synthetic_database" }],
    ["raw SQL REPLACE", { diagnostic: "REPLACE INTO synthetic_table" }],
    ["database endpoint", { databaseEndpoint: "mysql://synthetic.invalid/spx" }],
    ["SSH endpoint", { sshEndpoint: "ssh://synthetic.invalid" }],
    ["provider endpoint", { providerEndpoint: "https://api.synthetic.invalid" }],
    ["dotenv path", { configPath: "/synthetic/project/.env" }],
    ["FILE contents", { DB_PASSWORD_FILE: "synthetic-file-contents" }],
    ["target text", { target: "synthetic-target" }],
    ["message text", { message: "synthetic-message" }],
    ["payload text", { payload: "synthetic-payload" }],
    ["error text", { error: "synthetic-error" }],
    ["account identity", { accountId: "synthetic-account" }],
    ["username identity", { username: "synthetic-user" }],
    ["principal identity", { principal: "synthetic-principal" }],
  ];
  for (const [name, value] of cases) {
    await t.test(name, async () => {
      const fixture = await writeStaging(value);
      try {
        await assert.rejects(
          assertProtectedEvidenceFileSet("staging-gates", fixture.root),
          /redact|unsafe|sql|endpoint|environment|file|target|message|payload|error|account|identity|principal/i,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});
