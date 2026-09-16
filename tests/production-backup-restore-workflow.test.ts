import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const dispatcherPath = ".github/workflows/production-backup-restore.yml";
const trustedPath = ".github/workflows/trusted-production-backup-restore.yml";

assert.equal(existsSync(dispatcherPath), true, `${dispatcherPath} must exist`);
assert.equal(existsSync(trustedPath), true, `${trustedPath} must exist`);

const dispatcher = readFileSync(dispatcherPath, "utf8");
const trusted = readFileSync(trustedPath, "utf8");
const inputs = [
  "candidate_sha",
  "release_artifact_id",
  "release_run_id",
  "production_target_artifact_id",
  "production_target_run_id",
];

function pinnedActions(source: string): void {
  for (const match of source.matchAll(/uses:\s*([^\s]+)/g)) {
    assert.match(match[1], /@[0-9a-f]{40}$/, `mutable action reference: ${match[1]}`);
  }
}

function runBlocks(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const bodyIndent = lines[index].match(/^\s*/)?.[0].length ?? 0;
      if (lines[index].trim() && bodyIndent <= indent) {
        index -= 1;
        break;
      }
      body.push(lines[index]);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

assert.match(dispatcher, /^permissions:\s*\{\}\s*$/m);
assert.doesNotMatch(dispatcher, /\bruns-on:|^\s+steps:|\benvironment:/m);
assert.doesNotMatch(dispatcher, /\bssh\b|\bscp\b|\bdocker\b|secrets:\s*inherit/);
for (const secret of ["SPX_HOST", "SPX_PORT", "SPX_USER", "SPX_KNOWN_HOSTS", "SPX_SSH_KEY"]) {
  assert.match(
    dispatcher,
    new RegExp(`${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`),
    `dispatcher must pass ${secret} explicitly to the trusted reusable workflow`,
  );
  assert.match(
    trusted,
    new RegExp(`^\\s{6}${secret}:$`, "m"),
    `trusted workflow must declare ${secret} as a workflow-call secret`,
  );
}
assert.match(dispatcher, /STAGE-C-PIN/);
assert.match(
  dispatcher,
  /uses:\s*fastest4u\/SPX\/\.github\/workflows\/trusted-production-backup-restore\.yml@f4c103290ab30027e1fe7a426a91f1b8973b0426/,
);
for (const input of inputs) {
  assert.equal(
    [...dispatcher.matchAll(new RegExp(`^ {6}${input}:$`, "gm"))].length,
    2,
    `${input} must match workflow_dispatch and workflow_call`,
  );
  assert.match(
    dispatcher,
    new RegExp(`${input}:[\\s\\S]{0,180}required: true[\\s\\S]{0,80}type: string`),
  );
  assert.match(trusted, new RegExp(`^ {6}${input}:$`, "m"));
}
assert.match(
  dispatcher,
  /permissions:\s*\n\s+actions:\s*read\s*\n\s+attestations:\s*write\s*\n\s+contents:\s*read\s*\n\s+id-token:\s*write/,
);

assert.match(trusted, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(trusted, /workflow_dispatch:/);
assert.match(trusted, /^permissions:\s*\{\}\s*$/m);
assert.match(trusted, /environment:\s*production/);
assert.match(trusted, /group:\s*spx-production-mutation/);
assert.doesNotMatch(trusted, /^\s+queue:/m);
assert.match(trusted, /cancel-in-progress:\s*false/);
assert.match(
  trusted,
  /permissions:\s*\n\s+actions:\s*read\s*\n\s+attestations:\s*write\s*\n\s+contents:\s*read\s*\n\s+id-token:\s*write/,
);
assert.match(trusted, /ref:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trusted, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trusted, /SPX_TRUSTED_PRODUCTION_BACKUP_RESTORE_WORKFLOW_SHA/);
assert.doesNotMatch(trusted, /secrets:\s*inherit|ssh-keyscan/);
pinnedActions(trusted);

for (const block of runBlocks(trusted)) {
  assert.doesNotMatch(block, /\$\{\{\s*inputs\./, "shell blocks must receive inputs through env");
}
assert.doesNotMatch(trusted, /ref:\s*\$\{\{\s*inputs\.candidate_sha/);
assert.doesNotMatch(trusted, /(?:node|bash|sh)\s+[^\n]*inert-inputs\//);
assert.match(trusted, /release-artifact\.index\.json/);
assert.match(trusted, /deployment-target-descriptor\.json/);
assert.match(trusted, /releaseSourceSha/);
for (const workflow of [
  "trusted-release-artifact.yml",
  "deployment-target-descriptor-signer.yml",
]) {
  assert.match(
    trusted,
    new RegExp(
      `--signer-workflow fastest4u/SPX/\\.github/workflows/${workflow.replaceAll(".", "\\.")}`,
    ),
  );
}
assert.match(trusted, /--signer-digest/);
assert.match(trusted, /--deny-self-hosted-runners/);

for (const path of [
  "scripts/production-backup-restore-controller.mjs",
  "scripts/production-backup-restore-evidence.mjs",
  "scripts/production-mutation-host-lock.mjs",
  "scripts/lib/evidence-artifact.mjs",
  "scripts/lib/production-backup-live-adapter.mjs",
  "deploy/production-backup-context.schema.json",
  "deploy/production-backup-invariants.json",
  "deploy/production-backup-isolated-compose.yml",
  "verified-backup-context.json",
]) {
  assert.match(trusted, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.doesNotMatch(trusted, /cp\s+-a\s+trusted\/scripts\b/);
assert.match(trusted, /SPX_PRODUCTION_BACKUP_MYSQLDUMP_SHA256/);
assert.match(trusted, /SPX_PRODUCTION_BACKUP_MYSQL_SHA256/);
assert.match(trusted, /SPX_PRODUCTION_BACKUP_DOCKER_SHA256/);
assert.match(trusted, /SPX_PRODUCTION_BACKUP_KMS_ENVELOPE_SHA256/);
for (const protectedDigest of [
  "SPX_PRODUCTION_BACKUP_WORKFLOW_FILE_SHA256",
  "SPX_PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256",
  "SPX_PRODUCTION_BACKUP_CONTROLLER_SHA256",
  "SPX_PRODUCTION_BACKUP_LIVE_ADAPTER_SHA256",
  "SPX_PRODUCTION_BACKUP_INVARIANTS_SHA256",
  "SPX_PRODUCTION_BACKUP_ISOLATED_COMPOSE_SHA256",
]) {
  assert.match(trusted, new RegExp(protectedDigest));
}
assert.match(
  trusted,
  /production-backup-restore-evidence\.mjs[\s\S]*EXPECTED_EVIDENCE_VERIFIER_SHA256/,
  "the producer must bind the trusted evidence verifier bytes to the protected digest",
);
assert.match(trusted, /workflowFileSha256/);
const producerContext =
  /\n {12}producer:\s*\{([\s\S]*?)\n {12}\},\n {12}implementationSha256:/.exec(trusted);
assert.ok(producerContext, "the fixed context must separate producer and implementation hashes");
for (const field of [
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
]) {
  assert.match(producerContext[1], new RegExp(`\\b${field}\\b`));
}
assert.doesNotMatch(
  producerContext[1],
  /controllerSha256|liveAdapterSha256|invariantDefinitionsSha256|isolatedComposeSha256/,
  "implementation digests must not be exported as producer metadata",
);
assert.match(trusted, /\/var\/lib\/spx-production-backup\/context\/verified-backup-context\.json/);
assert.match(trusted, /PRODUCER_ROOT=\/var\/lib\/spx-production-backup\/producer/);
assert.match(trusted, /TRANSFER_ID:\s*production-backup-restore-/);
assert.match(trusted, /operationId:\s*randomUUID\(\)/);
assert.doesNotMatch(trusted, /operationId:\s*process\.env\.TRANSFER_ID/);
assert.match(
  trusted,
  /databaseFingerprint:\s*"sha256:"\s*\+\s*descriptor\.database\.tlsFingerprintSha256/,
);
assert.match(
  trusted,
  /\/usr\/bin\/node "\$\{PRODUCER_ROOT\}\/scripts\/production-backup-restore-controller\.mjs"/,
);
assert.doesNotMatch(
  trusted,
  /production-backup-restore-controller\.mjs\s+(?:--|\$\{|"\$\{)/,
  "controller CLI must be invoked without caller-selected arguments",
);

for (const output of [
  "production-backup-restore-evidence.json",
  "production-backup-restore-signature.json",
]) {
  assert.match(trusted, new RegExp(output.replaceAll(".", "\\.")));
  assert.match(
    trusted,
    new RegExp(`subject-path:[\\s\\S]{0,180}protected-output/${output.replaceAll(".", "\\.")}`),
  );
  assert.match(
    trusted,
    new RegExp(`path:[\\s\\S]{0,180}protected-output/${output.replaceAll(".", "\\.")}`),
  );
}
assert.match(trusted, /verifyProductionBackupRestoreEvidence/);
assert.match(trusted, /signatureSha256/);
assert.match(trusted, /subjectSha256/);
assert.match(trusted, /retention-days:\s*30/);
assert.match(
  trusted,
  /name:\s*spx-production-backup-restore-\$\{\{ inputs\.candidate_sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
);
assert.match(
  trusted,
  /RESUME_EXISTING_EXPORT="\$\([\s\S]*process\.stdout\.write\("false"\)[\s\S]*process\.stdout\.write\("true"\)[\s\S]*if \[ "\$\{RESUME_EXISTING_EXPORT\}" = false \]; then[\s\S]*production-backup-restore-controller\.mjs/,
  "an exact retained evidence pair must resume retrieval without rerunning the controller",
);
assert.match(
  trusted,
  /existing protected export file set is invalid/,
  "resume must fail closed for every missing, extra, or non-regular export entry",
);

const uploadIndex = trusted.indexOf("Upload one exact protected backup artifact");
const cleanupIndex = trusted.indexOf("Remove only exported evidence after successful upload");
assert.ok(uploadIndex > 0, "protected artifact upload step must exist");
assert.ok(
  cleanupIndex > uploadIndex,
  "host export cleanup must run only after a successful upload",
);
assert.match(
  trusted.slice(cleanupIndex),
  /production-backup-restore-evidence\.json[\s\S]*production-backup-restore-signature\.json/,
);
assert.match(trusted.slice(cleanupIndex), /stat\.uid[\s\S]*stat\.mode[\s\S]*unlink/);
assert.match(trusted.slice(cleanupIndex), /directory\.sync\(\)/);
assert.doesNotMatch(trusted.slice(cleanupIndex), /rm\s+-rf|find[^\n]*-delete/);

console.log("production backup restore workflow tests passed");
