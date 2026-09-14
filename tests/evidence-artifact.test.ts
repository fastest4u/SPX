import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  readEvidenceBundle,
  readEvidenceBytes,
  readEvidenceJson,
  validateReleaseBinding,
} from "../scripts/lib/evidence-artifact.mjs";

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
  stagingRunId: "staging-run-20260710-001",
};

const productionBinding = {
  candidateSha: "2".repeat(40),
  imageDigest: `sha256:${"3".repeat(64)}`,
  releaseManifestSha256: "4".repeat(64),
  environment: "supervised-production",
  topology: "split",
  composeProject: "spx-production",
  targetDescriptorSha256: "5".repeat(64),
  operatorBundleSha256: "6".repeat(64),
  productionIdentityApprovalSha256: "7".repeat(64),
};

async function main() {
  const root = await mkdtemp(join(tmpdir(), "spx-evidence-artifact-"));
  try {
    const regularPath = join(root, "regular.json");
    await writeFile(regularPath, JSON.stringify({ ok: true }), "utf8");
    assert.deepEqual(await readEvidenceJson(regularPath), { ok: true });
    assert.deepEqual(await readEvidenceBytes(regularPath), Buffer.from('{"ok":true}'));

    const nonCanonicalPath = join(root, "non-canonical.json");
    await writeFile(nonCanonicalPath, JSON.stringify({ z: 1, a: 2 }, null, 2), "utf8");
    await assert.rejects(
      () => readEvidenceJson(nonCanonicalPath, { requireCanonical: true }),
      /canonical JSON/i,
    );
    await writeFile(nonCanonicalPath, `${canonicalJson({ a: 2, z: 1 })}\n`, "utf8");
    await assert.rejects(
      () => readEvidenceJson(nonCanonicalPath, { requireCanonical: true }),
      /canonical JSON/i,
    );

    const symlinkPath = join(root, "linked.json");
    try {
      await symlink(regularPath, symlinkPath, "file");
      await assert.rejects(() => readEvidenceJson(symlinkPath), /symlink|regular file/i);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) {
        throw error;
      }
      await mkdir(symlinkPath);
      await assert.rejects(() => readEvidenceJson(symlinkPath), /regular file/i);
    }

    const oversizedPath = join(root, "oversized.json");
    await writeFile(oversizedPath, JSON.stringify({ value: "x".repeat(256) }), "utf8");
    await assert.rejects(
      () => readEvidenceJson(oversizedPath, { maxFileBytes: 128 }),
      /size limit/i,
    );

    const bundleDir = join(root, "bundle");
    await mkdir(bundleDir);
    await writeFile(
      join(bundleDir, "a.json"),
      canonicalJson({ releaseBinding: binding, evidence: { ok: true } }),
      "utf8",
    );
    await writeFile(
      join(bundleDir, "b.json"),
      canonicalJson({ releaseBinding: binding, evidence: { count: 1 } }),
      "utf8",
    );
    const bundle = await readEvidenceBundle(bundleDir, {
      allowedNames: ["a.json", "b.json"],
      expectedBinding: binding,
    });
    assert.deepEqual(Object.keys(bundle), ["a.json", "b.json"]);

    const nonCanonicalBundleFile = join(bundleDir, "a.json");
    await writeFile(
      nonCanonicalBundleFile,
      JSON.stringify({ releaseBinding: binding, evidence: { ok: true } }, null, 2),
      "utf8",
    );
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
        }),
      /canonical JSON/i,
    );

    const canonicalBoundFile = canonicalJson({
      evidence: { ok: true },
      releaseBinding: binding,
    });
    await writeFile(nonCanonicalBundleFile, canonicalBoundFile, "utf8");
    await writeFile(
      nonCanonicalBundleFile,
      canonicalBoundFile.replace('"ok":true', '"ok":true,"ok":false'),
      "utf8",
    );
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
        }),
      /duplicate JSON key|canonical JSON/i,
    );

    await writeFile(nonCanonicalBundleFile, canonicalBoundFile, "utf8");
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
          beforeFinalDirectoryCheck: async () => {
            await writeFile(join(bundleDir, "race.json"), "{}", "utf8");
          },
        }),
      /changed during validation|unexpected.*file/i,
    );
    await rm(join(bundleDir, "race.json"));

    await writeFile(nonCanonicalBundleFile, '{"note":"token=raw-secret"', "utf8");
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
        }),
      /secret-shaped/i,
    );
    await writeFile(nonCanonicalBundleFile, canonicalBoundFile, "utf8");

    await writeFile(join(bundleDir, "unexpected.json"), "{}", "utf8");
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
        }),
      /unexpected.*file/i,
    );
    await rm(join(bundleDir, "unexpected.json"));

    await mkdir(join(bundleDir, "subdirectory.json"));
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json", "subdirectory.json"],
          expectedBinding: binding,
        }),
      /subdirector|regular file/i,
    );
    await rm(join(bundleDir, "subdirectory.json"), { recursive: true });

    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
          maxTotalBytes: 100,
        }),
      /total size limit/i,
    );

    await writeFile(
      join(bundleDir, "a.json"),
      JSON.stringify({ releaseBinding: binding, note: "token=do-not-persist-this" }),
      "utf8",
    );
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
        }),
      /secret-shaped/i,
    );

    await writeFile(
      join(bundleDir, "a.json"),
      JSON.stringify({ releaseBinding: binding, note: "TODO replace this" }),
      "utf8",
    );
    await assert.rejects(
      () =>
        readEvidenceBundle(bundleDir, {
          allowedNames: ["a.json", "b.json"],
          expectedBinding: binding,
        }),
      /placeholder/i,
    );

    assert.deepEqual(validateReleaseBinding(binding), binding);
    assert.deepEqual(validateReleaseBinding(productionBinding), productionBinding);
    assert.throws(
      () => validateReleaseBinding({ ...productionBinding, stagingRunId: "wrong-schema" }),
      /canonical binding fields/i,
    );
    for (const [field, message] of [
      ["targetDescriptorSha256", /target descriptor/i],
      ["operatorBundleSha256", /operator bundle/i],
      ["productionIdentityApprovalSha256", /production identity approval/i],
    ] as const) {
      assert.throws(
        () => validateReleaseBinding(
          productionBinding,
          { ...productionBinding, [field]: "8".repeat(64) },
        ),
        message,
      );
    }
    assert.throws(
      () => validateReleaseBinding({ ...binding, candidateSha: "main" }),
      /40-character/i,
    );
    assert.throws(
      () => validateReleaseBinding({ ...binding, composeProject: "spx" }),
      /compose project/i,
    );
    for (const [field, message] of [
      ["stagingTargetDescriptorSha256", /target descriptor/i],
      ["operatorBundleSha256", /operator bundle/i],
      ["stagingApprovalEnvelopeSha256", /approval envelope/i],
      ["actionJournalHeadSha256", /journal head/i],
      ["stagingRunId", /run ID/i],
    ] as const) {
      assert.throws(
        () =>
          validateReleaseBinding(
            binding,
            field === "stagingRunId"
              ? { ...binding, [field]: "different-run" }
              : { ...binding, [field]: "9".repeat(64) },
          ),
        message,
      );
    }

    assert.equal(canonicalJson({ z: 1, a: { d: 2, b: 1 } }), '{"a":{"b":1,"d":2},"z":1}');
    assert.throws(() => canonicalJson({ invalid: Number.NaN }), /finite JSON number/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
