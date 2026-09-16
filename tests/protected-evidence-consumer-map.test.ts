import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertProtectedEvidenceFileSet,
  loadProtectedEvidenceProducerMap,
  producerFor,
} from "../scripts/lib/protected-evidence-producers.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";

const STAGE_A_SHA = "4c0b0cf57481eda1c88ac754fa70500cf0fb59ad";
const CUTOVER_PRODUCER_SHA = "1f5d7a419ea23e85e2b09888572063be0798169a";
const BACKUP_PRODUCER_SHA = "f4c103290ab30027e1fe7a426a91f1b8973b0426";
const WORKFLOW_DIGESTS: Record<string, string> = {
  ".github/workflows/gate6-accepted-evidence-exporter.yml": "72a83691e66f031ae979963911ee86e0f164dde490da964c8a6c2d869557940e",
  ".github/workflows/gate6-final-verifier-exporter.yml": "1599cf186f93a56ed3fc4de7dbd2a7b843aa64f3446a03543705969e960a4291",
  ".github/workflows/trusted-production-backup-restore.yml": "82e8b502a9cdb47544da19cfc9b4d64b5bfd727f3faf3e97af4cbab75151a87c",
  ".github/workflows/trusted-deploy.yml": "b2dc064840c3e388456e76e4c23fd0101813d915a62ef28ad42c98a260debb6e",
  ".github/workflows/trusted-staging-protected-evidence.yml": "be09053d94990f762e7f60a7f4957dcee7f9fe19440959eb21d2ab1bb27608d8",
};
const EXPECTED = {
  "staging-gates": {
    workflow: ".github/workflows/trusted-staging-protected-evidence.yml",
    environment: "staging",
    files: ["staging-protected-evidence.json"],
  },
  "production-backup-restore": {
    workflow: ".github/workflows/trusted-production-backup-restore.yml",
    environment: "production",
    files: ["production-backup-restore-evidence.json", "production-backup-restore-signature.json"],
  },
  "protected-install": {
    workflow: ".github/workflows/trusted-deploy.yml",
    environment: "production",
    files: ["protected-install-evidence.json", "protected-install-signature.json"],
  },
  "accepted-db-transition": {
    workflow: ".github/workflows/gate6-accepted-evidence-exporter.yml",
    environment: "production",
    files: ["accepted-db-transition-evidence.json"],
  },
  "accepted-pre-close": {
    workflow: ".github/workflows/gate6-accepted-evidence-exporter.yml",
    environment: "production",
    files: ["accepted-pre-close-evidence.json"],
  },
  "final-verifier": {
    workflow: ".github/workflows/gate6-final-verifier-exporter.yml",
    environment: "production",
    files: ["final-verifier.json"],
  },
} as const;

type Kind = keyof typeof EXPECTED;

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function primaryFor(kind: Kind, producer = producerDocument(kind)) {
  return {
    schemaVersion: 1,
    candidateSha: "a".repeat(40),
    producer,
  };
}

function producerDocument(kind: Kind) {
  const mapped = producerFor(kind);
  return {
    repository: "fastest4u/SPX",
    environment: mapped.environment,
    workflow: mapped.workflow,
    workflowSha: mapped.signerSha,
    workflowFileSha256: mapped.workflowFileSha256,
  };
}

function bundleValues(kind: Kind) {
  const mapped = producerFor(kind);
  const core = primaryFor(kind);
  if (mapped.files.length === 1) return { [mapped.files[0]]: core };
  const signature = {
    schemaVersion: 1,
    algorithm: "kms-sha256",
    keyId: `spx-${kind}-evidence-v1`,
    subjectSha256: sha256Canonical(core),
    signatureBase64: Buffer.from("synthetic protected evidence signature").toString("base64"),
    signedAt: "2026-07-16T01:00:00.000Z",
  };
  return {
    [mapped.files[0]]: { ...core, signatureSha256: sha256Canonical(signature) },
    [mapped.files[1]]: signature,
  };
}

async function fixture(kind: Kind) {
  const root = await mkdtemp(join(tmpdir(), "spx-producer-map-"));
  const values = bundleValues(kind);
  for (const [name, value] of Object.entries(values)) {
    await writeFile(join(root, name), canonicalJson(value));
  }
  return {
    root,
    values,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("loads the exact reviewed producer pins including the repinned backup producer", async () => {
  const map = loadProtectedEvidenceProducerMap();
  assert.deepEqual(Object.keys(map), Object.keys(EXPECTED).sort());
  assert.equal(Object.isFrozen(map), true);
  for (const kind of Object.keys(EXPECTED) as Kind[]) {
    const expected = EXPECTED[kind];
    const producer = producerFor(kind);
    const signerSha = kind === "production-backup-restore"
      ? BACKUP_PRODUCER_SHA
      : kind === "protected-install"
        ? CUTOVER_PRODUCER_SHA
        : STAGE_A_SHA;
    assert.equal(sha256(readFileSync(expected.workflow)), WORKFLOW_DIGESTS[expected.workflow]);
    assert.deepEqual(producer, {
      workflow: expected.workflow,
      environment: expected.environment,
      files: [...expected.files],
      signerSha,
      workflowFileSha256: WORKFLOW_DIGESTS[expected.workflow],
      bootstrapDenied: false,
    });
    assert.deepEqual(Object.keys(producer), [
      "workflow",
      "environment",
      "files",
      "signerSha",
      "workflowFileSha256",
      "bootstrapDenied",
    ]);
    assert.equal(Object.isFrozen(producer), true);
    assert.equal(Object.isFrozen(producer.files), true);
  }
  assert.throws(() => producerFor("unknown"), /kind|unknown/i);
});

test("returns exact ordered stable bytes, hashes, JSON values, and producer policy", async () => {
  for (const kind of Object.keys(EXPECTED) as Kind[]) {
    const f = await fixture(kind);
    try {
      const result = await assertProtectedEvidenceFileSet(kind, f.root);
      assert.equal(result.kind, kind);
      assert.deepEqual(result.producer, producerFor(kind));
      assert.deepEqual(
        result.files.map((file: { name: string }) => file.name),
        [...EXPECTED[kind].files],
      );
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.files), true);
      for (const file of result.files) {
        assert.equal(Object.isFrozen(file), true);
        assert.equal(file.sha256, sha256(file.bytes));
        assert.equal(file.bytes.toString("utf8"), canonicalJson(file.value));
        assert.equal(Object.isFrozen(file.value), true);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("rejects missing, extra, nested, symlinked, oversized, and non-canonical files", async (t) => {
  await t.test("missing", async () => {
    const f = await fixture("staging-gates");
    try {
      await unlink(join(f.root, EXPECTED["staging-gates"].files[0]));
      await assert.rejects(
        assertProtectedEvidenceFileSet("staging-gates", f.root),
        /missing|exact/i,
      );
    } finally {
      await f.cleanup();
    }
  });
  await t.test("extra", async () => {
    const f = await fixture("staging-gates");
    try {
      await writeFile(join(f.root, "manual-copy.json"), "{}");
      await assert.rejects(
        assertProtectedEvidenceFileSet("staging-gates", f.root),
        /unexpected|exact/i,
      );
    } finally {
      await f.cleanup();
    }
  });
  await t.test("nested", async () => {
    const f = await fixture("staging-gates");
    try {
      await mkdir(join(f.root, "nested"));
      await assert.rejects(
        assertProtectedEvidenceFileSet("staging-gates", f.root),
        /nested|directory|unexpected|regular/i,
      );
    } finally {
      await f.cleanup();
    }
  });
  await t.test("symlink", async (t) => {
    const f = await fixture("staging-gates");
    const outside = join(f.root, "..", `outside-${Date.now()}.json`);
    try {
      await writeFile(outside, canonicalJson(primaryFor("staging-gates")));
      await unlink(join(f.root, EXPECTED["staging-gates"].files[0]));
      try {
        await symlink(outside, join(f.root, EXPECTED["staging-gates"].files[0]), "file");
      } catch (error: unknown) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "")) {
          t.skip("symlink creation is unavailable");
          return;
        }
        throw error;
      }
      await assert.rejects(
        assertProtectedEvidenceFileSet("staging-gates", f.root),
        /symlink|regular/i,
      );
    } finally {
      await f.cleanup();
      await rm(outside, { force: true });
    }
  });
  await t.test("oversized", async () => {
    const f = await fixture("staging-gates");
    try {
      await writeFile(
        join(f.root, EXPECTED["staging-gates"].files[0]),
        JSON.stringify({ value: "x".repeat(1024 * 1024) }),
      );
      await assert.rejects(
        assertProtectedEvidenceFileSet("staging-gates", f.root),
        /size|oversized|limit/i,
      );
    } finally {
      await f.cleanup();
    }
  });
  await t.test("non-canonical", async () => {
    const f = await fixture("staging-gates");
    try {
      await writeFile(
        join(f.root, EXPECTED["staging-gates"].files[0]),
        JSON.stringify(primaryFor("staging-gates"), null, 2),
      );
      await assert.rejects(assertProtectedEvidenceFileSet("staging-gates", f.root), /canonical/i);
    } finally {
      await f.cleanup();
    }
  });
});

test("requires the primary producer to have exact mapped provenance", async (t) => {
  type MutableProducer = ReturnType<typeof producerDocument> & { manual?: boolean };
  const cases: Array<[string, (producer: MutableProducer) => void]> = [
    [
      "repository",
      (producer) => {
        producer.repository = "copied/SPX";
      },
    ],
    [
      "environment",
      (producer) => {
        producer.environment = "production";
      },
    ],
    [
      "workflow",
      (producer) => {
        producer.workflow = ".github/workflows/trusted-deploy.yml";
      },
    ],
    [
      "signer SHA",
      (producer) => {
        producer.workflowSha = "a".repeat(40);
      },
    ],
    [
      "workflow digest",
      (producer) => {
        producer.workflowFileSha256 = "b".repeat(64);
      },
    ],
    [
      "extra field",
      (producer) => {
        producer.manual = true;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const f = await fixture("staging-gates");
      try {
        const value = primaryFor("staging-gates") as ReturnType<typeof primaryFor> & {
          producer: MutableProducer;
        };
        mutate(value.producer);
        await writeFile(join(f.root, EXPECTED["staging-gates"].files[0]), canonicalJson(value));
        await assert.rejects(
          assertProtectedEvidenceFileSet("staging-gates", f.root),
          /producer|provenance|map/i,
        );
      } finally {
        await f.cleanup();
      }
    });
  }
});

test("binds signature file digest and signed core digest for paired evidence", async () => {
  const f = await fixture("production-backup-restore");
  try {
    const mapped = producerFor("production-backup-restore");
    const signature = structuredClone(f.values[mapped.files[1]]) as Record<string, unknown> & {
      subjectSha256: string;
    };
    signature.subjectSha256 = "f".repeat(64);
    const evidence = structuredClone(f.values[mapped.files[0]]) as Record<string, unknown> & {
      signatureSha256: string;
    };
    evidence.signatureSha256 = sha256Canonical(signature);
    await writeFile(join(f.root, mapped.files[0]), canonicalJson(evidence));
    await writeFile(join(f.root, mapped.files[1]), canonicalJson(signature));
    await assert.rejects(
      assertProtectedEvidenceFileSet("production-backup-restore", f.root),
      /subject|signed core|signature/i,
    );
  } finally {
    await f.cleanup();
  }

  const mismatch = await fixture("protected-install");
  try {
    const mapped = producerFor("protected-install");
    const evidence = structuredClone(mismatch.values[mapped.files[0]]) as Record<string, unknown> & {
      signatureSha256: string;
    };
    evidence.signatureSha256 = "e".repeat(64);
    await writeFile(join(mismatch.root, mapped.files[0]), canonicalJson(evidence));
    await assert.rejects(
      assertProtectedEvidenceFileSet("protected-install", mismatch.root),
      /signature.*digest|signature.*hash/i,
    );
  } finally {
    await mismatch.cleanup();
  }
});
