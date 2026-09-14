import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STAGING_PROVISIONED_DB_ROLES } from "../scripts/lib/staging-action-capability.mjs";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import {
  STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS,
  validateExtractedStagingProtectedCapability,
  validateStagingProtectedCapabilityArchiveBytes,
} from "../scripts/lib/staging-protected-capability-archive.mjs";

type TarEntry = { name: string; type?: string; body?: Buffer; linkName?: string; prefix?: string };

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "ascii");
    header.write(octal(entry.type === "5" ? 0o700 : 0o400, 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(body.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.linkName) header.write(entry.linkName, 157, 100, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (entry.prefix) header.write(entry.prefix, 345, 155, "ascii");
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return Buffer.concat(chunks);
}

const password = Buffer.from("P".repeat(32));
const policy = Buffer.from(
  '{"endpoint":"https://observer.example/internal/ready","schemaVersion":1}',
);
const token = Buffer.from("T".repeat(32));
const leafBody = (name: string) => {
  if (name === "action-capability.json") return Buffer.from("{}");
  if (name === "db-ca.pem") return Buffer.from("test-ca");
  if (name === "phase3-production-observer-policy.json") return policy;
  if (name === "phase3-production-observer-token") return token;
  return password;
};
const validEntries: TarEntry[] = STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS.map((name) => ({
  name,
  type: name === "database/" ? "5" : "0",
  body: name === "database/" ? Buffer.alloc(0) : leafBody(name),
}));

assert.deepEqual(STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS, [
  "action-capability.json",
  "database/",
  "database/bootstrap.password",
  "database/phase3-control.password",
  ...STAGING_PROVISIONED_DB_ROLES.map((role) => `database/principal-${role}.password`),
  "db-ca.pem",
  "phase3-production-observer-policy.json",
  "phase3-production-observer-token",
].sort());
assert.deepEqual(
  validateStagingProtectedCapabilityArchiveBytes(tar(validEntries)).members,
  STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS,
);

for (const [label, entries] of [
  ["duplicate", [...validEntries, validEntries[0]]],
  ["traversal", [...validEntries.slice(1), { ...validEntries[0], name: "../action-capability.json" }]],
  ["symlink", validEntries.map((entry, index) => index === 0 ? { ...entry, type: "2", linkName: "/tmp/x" } : entry)],
  ["hardlink", validEntries.map((entry, index) => index === 0 ? { ...entry, type: "1", linkName: "db-ca.pem" } : entry)],
  ["fifo", validEntries.map((entry, index) => index === 0 ? { ...entry, type: "6" } : entry)],
  ["pax", [...validEntries, { name: "pax", type: "x", body: Buffer.from("x") }]],
  ["gnu", [...validEntries, { name: "long", type: "L", body: Buffer.from("x") }]],
  ["extra directory", [...validEntries, { name: "extra/", type: "5" }]],
  ["prefix", validEntries.map((entry, index) => index === 0 ? { ...entry, prefix: "hidden" } : entry)],
] as const) {
  assert.throws(
    () => validateStagingProtectedCapabilityArchiveBytes(tar(entries as TarEntry[])),
    /protected staging capability archive is invalid/i,
    label,
  );
}
assert.throws(
  () => validateStagingProtectedCapabilityArchiveBytes(Buffer.alloc(1_048_577)),
  /protected staging capability archive is invalid/i,
);
assert.throws(
  () => validateStagingProtectedCapabilityArchiveBytes(tar(validEntries.map((entry) =>
    entry.name === "phase3-production-observer-token"
      ? { ...entry, body: Buffer.alloc(4_097, 0x41) }
      : entry))),
  /protected staging capability archive is invalid/i,
);

async function main(): Promise<void> {
const temp = await mkdtemp(join(tmpdir(), "spx-protected-capability-"));
try {
  const root = join(temp, "extracted");
  await mkdir(join(root, "database"), { recursive: true });
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
    stagingRunId: "staging-run-001",
  };
  const capability = {
    schemaVersion: 1,
    releaseBinding: binding,
    database: {
      host: "mysql.staging.internal",
      port: 3306,
      name: "spx_staging",
      sslServername: "mysql.staging.internal",
      caSha256: createHash("sha256").update("test-ca").digest("hex"),
      actors: { bootstrap: "spx_staging_bootstrap", phase3Control: "spx_stg_phase3_control" },
      actorHosts: { bootstrap: "172.17.0.1", phase3Control: "172.17.0.1" },
      principalRoles: STAGING_PROVISIONED_DB_ROLES,
    },
    phase3: { canaryTeamId: 2, canaryEpoch: "phase3-ifn-20260710" },
  };
  for (const name of STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS) {
    if (name === "database/") continue;
    let bytes = leafBody(name);
    if (name === "action-capability.json") bytes = Buffer.from(canonicalJson(capability));
    await writeFile(join(root, ...name.split("/")), bytes);
  }
  const policySha256 = createHash("sha256").update(policy).digest("hex");
  const signedAccountHosts = Object.fromEntries(
    STAGING_PROVISIONED_DB_ROLES.map((role) => [role, "172.17.0.1"]),
  );
  assert.equal(
    await validateExtractedStagingProtectedCapability(root, {
      installedBinding: binding,
      expectedPolicySha256: policySha256,
      signedAccountHosts,
      continuousPolicyBytes: Buffer.from(
        '{"credentialPath":"/run/credentials/spx-production-observer-token","endpoint":"https://observer.example/internal/ready"}',
      ),
    }),
    true,
  );

  const observerPassword = join(root, "database", "principal-phase3-observer.password");
  const alias = join(temp, "observer-alias.password");
  await link(observerPassword, alias);
  await assert.rejects(
    validateExtractedStagingProtectedCapability(root, {
      installedBinding: binding,
      expectedPolicySha256: policySha256,
      signedAccountHosts,
      continuousPolicyBytes: Buffer.from(
        '{"credentialPath":"/run/credentials/spx-production-observer-token","endpoint":"https://observer.example/internal/ready"}',
      ),
    }),
    /protected staging capability extraction is invalid/i,
  );
  await rm(alias);
  await assert.rejects(
    validateExtractedStagingProtectedCapability(root, {
      installedBinding: binding,
      expectedPolicySha256: policySha256,
      signedAccountHosts: { ...signedAccountHosts, "phase3-observer": "%" },
      continuousPolicyBytes: Buffer.from(
        '{"credentialPath":"/run/credentials/spx-production-observer-token","endpoint":"https://observer.example/internal/ready"}',
      ),
    }),
    /protected staging capability extraction is invalid/i,
  );
  await chmod(observerPassword, 0o600);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log("staging protected capability archive tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
