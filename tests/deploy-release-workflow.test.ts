import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const deployDispatcherSource = readFileSync(".github/workflows/a3-deploy.yml", "utf8");
const deploySource = readFileSync(".github/workflows/trusted-deploy.yml", "utf8");
const releaseSource = readFileSync(".github/workflows/release-artifact.yml", "utf8");
const trustedReleaseSource = readFileSync(".github/workflows/trusted-release-artifact.yml", "utf8");
const identityDispatcherSource = readFileSync(
  ".github/workflows/production-project-identity.yml",
  "utf8",
);
const identitySource = readFileSync(
  ".github/workflows/trusted-production-project-identity.yml",
  "utf8",
);
const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));

assert.match(deployDispatcherSource, /^permissions:\s*\{\}\s*$/m);
assert.match(deploySource, /^permissions:\s*\{\}\s*$/m);

function assertPinnedActions(source: string, file: string): void {
  for (const uses of source.matchAll(/uses:\s*([^\s]+)/g)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/, `${file} action must be pinned: ${uses[1]}`);
  }
}

function extractComposeCommands(source: string): string[] {
  return source
    .replace(/\\\r?\n[ \t]*/g, " ")
    .split(/\r?\n/)
    .filter((line) => /docker compose\b/.test(line) && !/^\s*#/.test(line))
    .map((line) => line.trim());
}

function assertAppearsBefore(source: string, before: string, after: string, message: string): void {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.notEqual(beforeIndex, -1, `${message}: missing prerequisite`);
  assert.notEqual(afterIndex, -1, `${message}: missing protected operation`);
  assert.ok(beforeIndex < afterIndex, message);
}

function logicalShellCommands(source: string): string[] {
  return source
    .replace(/\\\r?\n[ \t]*/g, " ")
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function containsHealthyTerminalHostLock(source: string): boolean {
  return logicalShellCommands(source).some(
    (command) =>
      /production-mutation-host-lock\.mjs\b/.test(command) &&
      /--action=(?:"?terminal"?)\b/.test(command) &&
      /--postcondition=(?:"?healthy"?)\b/.test(command),
  );
}

function workflowJob(source: string, jobName: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `workflow job ${jobName} is missing`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function assertExactReusableWorkflowPin(
  source: string,
  jobName: string,
  expectedWorkflow: string,
): void {
  const job = workflowJob(source, jobName);
  const uses = [...job.matchAll(/^ {4}uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.equal(uses.length, 1, `workflow job ${jobName} must have one active reusable call`);
  assert.match(
    uses[0] ?? "",
    new RegExp(`^${expectedWorkflow.replaceAll("/", "\\/")}@[0-9a-f]{40}$`),
  );
  assert.doesNotMatch(job, /\bruns-on:|^ {4}steps:/m);
}

function jobPermissions(source: string, jobName: string): Record<string, string> {
  const lines = workflowJob(source, jobName).split("\n");
  const start = lines.findIndex((line) => line === "    permissions:");
  assert.notEqual(start, -1, `workflow job ${jobName} permissions are missing`);
  const entries: Array<[string, string]> = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {6}([A-Za-z-]+):\s*(\S+)\s*$/.exec(line);
    if (!match) break;
    entries.push([match[1], match[2]]);
  }
  assert.ok(entries.length > 0, `workflow job ${jobName} permissions are empty`);
  return Object.fromEntries(entries);
}

assert.throws(
  () => assertAppearsBefore("after", "before", "after", "synthetic ordering gate"),
  /missing prerequisite/,
);
assert.equal(
  containsHealthyTerminalHostLock(
    "node production-mutation-host-lock.mjs --postcondition=healthy --action=terminal",
  ),
  true,
);
assert.throws(() =>
  assertExactReusableWorkflowPin(
    "jobs:\n  deploy:\n    # trusted.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    uses: owner/repo/.github/workflows/trusted.yml@main\n",
    "deploy",
    "owner/repo/.github/workflows/trusted.yml",
  ),
);
assert.deepEqual(
  jobPermissions(
    "jobs:\n  build:\n    permissions:\n      contents: read\n      packages: write\n    steps:\n      - run: true\n",
    "build",
  ),
  { contents: "read", packages: "write" },
);

assert.doesNotMatch(
  deploySource,
  /git\s+(?:fetch|pull|checkout|reset)|spx-app:latest|compose\s+build|docker\s+build/,
);
assert.doesNotMatch(deploySource, /deploy_topology:|project_identity_action:/);
assert.doesNotMatch(
  deploySource,
  /create-release-manifest|npm\s+(?:ci|run\s+build)|\/proc\/sys\/kernel\/random\/uuid|ssh-keyscan/,
);
assert.match(deploySource, /release_artifact_id:/);
assert.match(deploySource, /target_descriptor_artifact_id:/);
for (const input of ["backup_evidence_artifact_id", "backup_evidence_run_id"]) {
  assert.match(deployDispatcherSource, new RegExp(`\\b${input}:`));
  assert.match(deploySource, new RegExp(`\\b${input}:`));
  assert.match(deployDispatcherSource, new RegExp(`${input}: \\$\\{\\{ inputs\\.${input} \\}\\}`));
}
assert.match(
  deploySource,
  /TARGET.*production[\s\S]*BACKUP_EVIDENCE_ARTIFACT_ID[\s\S]*\^\[1-9\]\[0-9\]\*\$[\s\S]*BACKUP_EVIDENCE_RUN_ID/,
  "production must require both immutable backup selectors",
);
assert.match(
  deploySource,
  /TARGET.*staging[\s\S]*test -z "\$\{BACKUP_EVIDENCE_ARTIFACT_ID\}"[\s\S]*test -z "\$\{BACKUP_EVIDENCE_RUN_ID\}"/,
  "staging must reject every backup selector",
);
assert.match(deploySource, /artifact-ids:\s*\$\{\{ inputs\.backup_evidence_artifact_id \}\}/);
assert.match(deploySource, /run-id:\s*\$\{\{ inputs\.backup_evidence_run_id \}\}/);
assert.match(deploySource, /production-backup-restore-evidence\.json/);
assert.match(deploySource, /production-backup-restore-signature\.json/);
assert.match(
  deploySource,
  /trusted-production-backup-restore\.yml[\s\S]*SPX_TRUSTED_PRODUCTION_BACKUP_RESTORE_WORKFLOW_SHA/,
);
assert.match(deploySource, /verifyProductionBackupRestoreEvidence/);
assert.match(deploySource, /backupEvidenceSha256/);
assert.equal(
  [...deploySource.matchAll(/uses:\s*actions\/checkout@([0-9a-f]{40})/g)].length,
  2,
  "trusted deploy must checkout only the backup verifier and trusted install-evidence producer",
);
assert.match(
  deploySource,
  /ref:\s*\$\{\{\s*vars\.SPX_TRUSTED_PRODUCTION_BACKUP_RESTORE_WORKFLOW_SHA\s*\}\}/,
  "the semantic verifier checkout must use the protected backup producer SHA",
);
assert.match(deploySource, /path:\s*trusted-backup-verifier/);
assert.match(
  deploySource,
  /Checkout immutable trusted install evidence source[\s\S]*if:\s*inputs\.target == 'production'[\s\S]*ref:\s*\$\{\{\s*job\.workflow_sha\s*\}\}[\s\S]*path:\s*trusted-install-evidence/,
);
assert.match(
  deploySource,
  /SPX_PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256/,
  "trusted deploy must bind the verifier bytes to a protected digest",
);
assert.match(
  deploySource,
  /trusted-backup-verifier\/scripts\/production-backup-restore-evidence\.mjs/,
);
assert.doesNotMatch(
  deploySource,
  /verified\/operator\/scripts\/production-backup-restore-evidence\.mjs/,
  "candidate operator code must never decide whether backup evidence is valid",
);
for (const mutationMarker of [
  "Upload verified immutable payload",
  "production-mutation-host-lock.mjs --action=acquire",
  'docker start "${MIGRATOR_CONTAINER}"',
]) {
  assertAppearsBefore(
    deploySource,
    "verifyProductionBackupRestoreEvidence",
    mutationMarker,
    `backup verification must precede ${mutationMarker}`,
  );
}
assertAppearsBefore(
  deploySource,
  "backupEvidenceSha256:",
  "Upload verified immutable payload",
  "the verified backup hash must be frozen into deployment context before SSH upload",
);
assert.match(
  deploySource,
  /state: "installing"[\s\S]*backupEvidenceSha256:\s*process\.env\.EVIDENCE_BACKUP_SHA256/,
  "the protected install intent must bind the verified backup evidence hash",
);
assert.match(deploySource, /target:/);
assert.match(deploySource, /SPX_KNOWN_HOSTS/);
assert.match(deploySource, /KNOWN_HOST_LOOKUP/);
assert.match(deploySource, /permissions:[\s\S]*contents:\s*read/);
assert.match(deploySource, /attestations:\s*write/);
assert.match(deploySource, /id-token:\s*write/);
assert.doesNotMatch(deploySource, /attestations:\s*read/);
assert.match(deploySource, /SPX_PRODUCTION_COMPOSE_PROJECT:\s*spx-production/);
assert.match(deploySource, /production-project-identity\.mjs --action=verify/);
assert.match(deploySource, /production-mutation-host-lock\.mjs --action=(?:acquire|verify)/);
assert.match(deploySource, /protected-install-watchdog\.mjs --action=claim-bootstrap-slot/);
assert.doesNotMatch(deploySource, /protected-install-watchdog\.mjs --action=finalize-slot/);
assert.doesNotMatch(
  deploySource,
  /production-mutation-host-lock\.mjs"?\s+--action=installed-awaiting-gate6/,
);
for (const protectedInstallVariable of [
  "SPX_PROTECTED_INSTALL_EVIDENCE_WORKFLOW_FILE_SHA256",
  "SPX_PROTECTED_INSTALL_EVIDENCE_ASSEMBLER_SHA256",
  "SPX_PROTECTED_INSTALL_EVIDENCE_SCHEMA_SHA256",
  "SPX_PROTECTED_INSTALL_EVIDENCE_SIGNING_KEY_ID",
]) {
  assert.match(deploySource, new RegExp(protectedInstallVariable));
}
const protectedInstallProducerBlocks = [
  ...deploySource.matchAll(/const producer = (?:canonical\()?\{([\s\S]*?)\}\)?;/g),
]
  .map((match) => match[1])
  .filter((block) => block.includes('workflow: ".github/workflows/trusted-deploy.yml"'));
assert.equal(
  protectedInstallProducerBlocks.length,
  2,
  "packaging and local verification must use the same protected-install producer contract",
);
for (const block of protectedInstallProducerBlocks) {
  assert.deepEqual(
    [...block.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]),
    ["repository", "environment", "workflow", "workflowSha", "workflowFileSha256"],
    "protected-install producer metadata must contain exactly five workflow identity fields",
  );
}
assert.match(deploySource, /trusted-install-evidence\/scripts\/protected-install-evidence\.mjs/);
assert.match(
  deploySource,
  /trusted-install-evidence\/deploy\/protected-install-evidence\.schema\.json/,
);
assert.doesNotMatch(
  deploySource,
  /verified\/operator\/scripts\/protected-install-evidence\.mjs/,
  "candidate operator code must not assemble or verify protected install evidence",
);
assert.match(
  deploySource,
  /PROTECTED_INSTALL_PRODUCERS_ROOT=\/var\/lib\/spx-protected-install\/producers/,
  "trusted evidence producers must live below a versioned immutable parent",
);
assert.match(
  deploySource,
  /PROTECTED_INSTALL_PRODUCER_ROOT="\$\{PROTECTED_INSTALL_PRODUCERS_ROOT\}\/\$\{PROTECTED_INSTALL_PRODUCER_SHA256\}"/,
  "the verified producer payload digest must select the executable code root",
);
assert.match(
  deploySource,
  /PROTECTED_INSTALL_PRODUCER_STAGE="\$\{PROTECTED_INSTALL_PRODUCERS_ROOT\}\/\.\$\{PROTECTED_INSTALL_PRODUCER_SHA256\}\.\$\{OPERATION_ID\}\.new"/,
  "a new trusted producer version must be staged under the root-owned producer parent",
);
assert.match(
  deploySource,
  /mv "\$\{PROTECTED_INSTALL_PRODUCER_STAGE\}" "\$\{PROTECTED_INSTALL_PRODUCER_ROOT\}"/,
  "trusted producer installation must become visible atomically",
);
assert.match(
  deploySource,
  /\/usr\/bin\/node "\$\{PROTECTED_INSTALL_PRODUCER_ROOT\}\/scripts\/protected-install-evidence\.mjs"\s*$/m,
  "the fixed protected install driver must accept zero arguments",
);
assert.match(deploySource, /verifyProtectedInstallEvidence/);
assert.match(deploySource, /protected-install-evidence\.json/);
assert.match(deploySource, /protected-install-signature\.json/);
assert.match(deploySource, /retention-days:\s*30/);
assert.match(
  deploySource,
  /name:\s*spx-protected-install-evidence-\$\{\{ steps\.context\.outputs\.source_sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
);
assert.match(
  deploySource,
  /evidenceSha256:[\s\S]*candidateSha:[\s\S]*releaseManifestSha256:[\s\S]*targetDescriptorSha256:[\s\S]*databaseFingerprint:[\s\S]*backupSha256:[\s\S]*beforeDdl:[\s\S]*encrypted:[\s\S]*isolatedRestore:[\s\S]*teardownProven:/,
  "the verified backup evidence must be normalized to the core input summary",
);
const protectedInstallBaseContextNames = [
  "verified-install-context.json",
  "verified-producer-context.json",
  "verified-backup-evidence-summary.json",
  "verified-migration-receipt.json",
  "verified-online-ddl-receipts.json",
  "verified-grant-evidence.json",
  "verified-service-activation-journal.json",
  "verified-watchdog-journal.json",
  "verified-health-evidence.json",
  "verified-watermark-evidence.json",
  "verified-rollback-readiness.json",
  "verified-signing-context.json",
];
const protectedContextListIndex = deploySource.indexOf("PROTECTED_INSTALL_BASE_CONTEXT_FILES=");
const protectedCommitIndex = deploySource.indexOf(
  '/usr/bin/node "${PROTECTED_INSTALL_PRODUCER_ROOT}/scripts/protected-install-evidence.mjs"',
);
assert.notEqual(
  protectedContextListIndex,
  -1,
  "the workflow must declare the exact fixed base-context file set",
);
assert.ok(
  protectedCommitIndex > protectedContextListIndex,
  "the base-context boundary must be declared before the zero-argument commit",
);
const protectedContextMaterialization = deploySource.slice(
  protectedContextListIndex,
  protectedCommitIndex,
);
for (const name of protectedInstallBaseContextNames) {
  assert.match(
    protectedContextMaterialization,
    new RegExp(name.replaceAll(".", "\\.")),
    `${name} must be materialized before the evidence CLI runs`,
  );
}
assert.doesNotMatch(
  protectedContextMaterialization,
  /protected-install-signing-intent\.json|protected-install-signature\.json/,
  "only the zero-argument evidence CLI may create the durable signing intent and signature",
);
for (const actualFactBoundary of [
  'MIGRATION_RESULT_JSON="$(docker logs "${MIGRATOR_CONTAINER}" 2>/dev/null)"',
  "GRANT_PREFLIGHT_FACTS",
  "REPLAY_PREFLIGHT_FACTS",
  "LIVE_SERVICE_FACTS",
  "previewPreparedGate6SlotWithMysqlClient",
  "previewProductionInstallHostLockCommit",
  "/usr/local/libexec/spx-kms-envelope",
  "/run/credentials/spx-protected-install-evidence-kms.json",
]) {
  assert.match(
    protectedContextMaterialization,
    new RegExp(actualFactBoundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `protected-install context must be grounded in the verified fact boundary: ${actualFactBoundary}`,
  );
}
assert.match(
  protectedContextMaterialization,
  /classifiedPendingAlters\.length !== 0[\s\S]*verified online DDL receipts are unavailable/,
  "an applied ALTER without real bounded online-DDL measurements must fail closed",
);
assertAppearsBefore(
  deploySource,
  "LIVE_HEALTH_SHA256=",
  '/usr/bin/node "${PROTECTED_INSTALL_PRODUCER_ROOT}/scripts/protected-install-evidence.mjs"',
  "complete install facts must exist before deterministic evidence commit",
);
assertAppearsBefore(
  deploySource,
  '/usr/bin/node "${PROTECTED_INSTALL_PRODUCER_ROOT}/scripts/protected-install-evidence.mjs"',
  "Retrieve exact protected install evidence exports",
  "both durable states must reconcile before evidence leaves the protected host",
);
for (const productionOnlyStep of [
  "Checkout immutable trusted install evidence source",
  "Prove and package immutable trusted install evidence producer",
  "Upload trusted install evidence producer",
  "Retrieve exact protected install evidence exports",
  "Verify exact protected install evidence locally",
  "Attest protected install evidence",
  "Attest protected install signature",
  "Upload protected install evidence artifact",
  "Remove protected install exports after successful upload",
]) {
  assert.match(
    deploySource,
    new RegExp(`${productionOnlyStep}[\\s\\S]{0,180}if: inputs\\.target == 'production'`),
    `${productionOnlyStep} must never run for staging`,
  );
}
assert.equal(
  [...deploySource.matchAll(/uses:\s*actions\/attest-build-provenance@[0-9a-f]{40}/g)].length,
  2,
  "evidence and signature must receive separate attestations",
);
for (const output of ["protected-install-evidence.json", "protected-install-signature.json"]) {
  assert.match(
    deploySource,
    new RegExp(`subject-path:\\s*protected-install-output/${output.replaceAll(".", "\\.")}`),
  );
  assert.match(
    deploySource,
    new RegExp(`path:[\\s\\S]{0,180}protected-install-output/${output.replaceAll(".", "\\.")}`),
  );
}
assertAppearsBefore(
  deploySource,
  "Upload protected install evidence artifact",
  "Remove protected install exports after successful upload",
  "host exports must remain recoverable until artifact upload succeeds",
);
const localVerifierStart = deploySource.indexOf("Verify exact protected install evidence locally");
const localVerifierEnd = deploySource.indexOf("Attest protected install evidence");
assert.ok(localVerifierStart >= 0 && localVerifierEnd > localVerifierStart);
const localVerifierBlock = deploySource.slice(localVerifierStart, localVerifierEnd);
assert.match(localVerifierBlock, /EXPECTED_STATE_B64/);
assert.doesNotMatch(
  localVerifierBlock,
  /rollbackSha:\s*evidence\.rollbackSha|rollbackImageDigest:\s*evidence\.rollbackImageDigest|rollbackReleaseManifestSha256:\s*evidence\.rollbackReleaseManifestSha256|hostLock:\s*evidence\.hostLock|databaseSlot:\s*evidence\.databaseSlot/,
  "local verification must not use the artifact under test as its own rollback/lock/slot expectation",
);
assert.match(
  deploySource,
  /id:\s*protected-install-state[\s\S]*verifier_expectation_b64/,
  "the authenticated host/DB post-state observation must be passed separately to local verification",
);
const successfulProtectedCleanupStart = deploySource.indexOf(
  "Remove protected install exports after successful upload",
);
const successfulProtectedCleanup = deploySource.slice(successfulProtectedCleanupStart);
for (const name of [
  ...protectedInstallBaseContextNames,
  "protected-install-signing-intent.json",
  "protected-install-signature.json",
]) {
  assert.match(
    successfulProtectedCleanup,
    new RegExp(name.replaceAll(".", "\\.")),
    `${name} must remain recoverable until upload and then be removed to permit trusted-producer rotation`,
  );
}
assert.match(
  deploySource,
  /install -m 0444 "\$\{WATCHDOG_ROOT\}\/deploy\/systemd\/spx-protected-install-watchdog@\.service" "\$\{WATCHDOG_UNIT_FILE\}"/,
);
assert.match(deploySource, /WATCHDOG_PARENT=\/var\/lib\/spx-protected-install\/watchdogs/);
assert.match(deploySource, /WATCHDOG_ROOT="\$\{WATCHDOG_PARENT\}\/\$\{SOURCE_SHA\}"/);
assert.match(deploySource, /\$\{WATCHDOG_ROOT\}\.new/);
assert.match(deploySource, /operator-bundle\.index\.json/);
assert.match(deploySource, /cmp -s[\s\S]*WATCHDOG_ROOT/);
assert.match(deploySource, /spx-protected-install-watchdog@\$\{SOURCE_SHA\}\.service/);
assert.doesNotMatch(
  deploySource.match(/install_protected_watchdog\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "",
  /\/root\/SPX/,
);
assert.match(deploySource, /GATE6_CAPABILITY_CONFIG=\/var\/lib\/spx-gate6\/gate6-control-db\.json/);
assert.match(
  deploySource,
  /GATE6_CAPABILITY_PASSWORD=\/var\/lib\/spx-gate6\/secrets\/gate6-control-db-password/,
);
assert.match(deploySource, /GATE6_CAPABILITY_CA=\/var\/lib\/spx-gate6\/config\/db-ca\.pem/);
assert.doesNotMatch(deploySource, /gate6-control\.cnf/);
assert.match(deploySource, /ROLLBACK_STATE_ROOT=\/var\/lib\/spx-protected-install\/rollback/);
assert.match(deploySource, /ROLLBACK_JOURNAL="\$\{ROLLBACK_STATE_DIR\}\/rollback-journal\.json"/);
assert.doesNotMatch(deploySource, /ROLLBACK_JOURNAL="\$\{INCOMING\}/);
assert.match(deploySource, /--rollback-release-sha256="\$\{ROLLBACK_RELEASE_MANIFEST_SHA256\}"/);
assert.match(deploySource, /--rollback-service-set-sha256="\$\{ROLLBACK_SERVICE_SET_SHA256\}"/);
assert.match(deploySource, /--rollback-config-sha256="\$\{ROLLBACK_CONFIG_SHA256\}"/);
assert.match(deploySource, /trap early_on_error ERR/);
assert.ok(
  deploySource.indexOf("trap early_on_error ERR") <
    deploySource.indexOf("production-mutation-host-lock.mjs --action=acquire"),
  "the failure trap must be active before the production lock mutation",
);
assert.match(deploySource, /protected-install-watchdog\.mjs --action=compensate-slot/);
assert.match(deploySource, /ROLLBACK_EVIDENCE_SHA256=.*sha256sum/);
assert.match(deploySource, /--postcondition-sha256="\$\{ROLLBACK_EVIDENCE_SHA256\}"/);
assert.match(deploySource, /com\.spx\.release-sha.*previous_release_sha/);
assert.match(deploySource, /--profile "\*" stop/);
assert.match(deploySource, /--filter "label=com\.spx\.release-sha=\$\{SOURCE_SHA\}"/);
assertAppearsBefore(deploySource, "previous runtime cannot roll back on the candidate schema", "docker load --input",
  "incompatible rollback must fail before image load or migration");
assert.match(deploySource, /PROTECTED_ADOPTION_PRECONDITION/);
assert.match(deploySource, /WATCHDOG_UNIT_FILE="\/etc\/systemd\/system\/\$\{WATCHDOG_UNIT\}"/);
assert.doesNotMatch(
  deploySource,
  /\/etc\/systemd\/system\/spx-protected-install-watchdog@\.service/,
);
assert.match(
  deploySource,
  /verify_watchdog_file "deploy\/systemd\/spx-protected-install-watchdog@\.service"/,
);
assert.match(deploySource, /STAGING_CAPABILITY_BUNDLE_SHA256/);
assert.match(deploySource, /\/etc\/spx-staging\/action-capability\.json/);
assert.match(deploySource, /\/etc\/spx-staging\/db-ca\.pem/);
assert.match(deploySource, /\/etc\/spx-staging\/phase3-production-observer-policy\.json/);
assert.match(deploySource, /\/run\/spx-staging-actions\/phase3-production-observer-token/);
assertAppearsBefore(
  deploySource,
  'staging-protected-capability-archive.mjs" validate-archive',
  'tar -xf "${STAGING_CAPABILITY_PAYLOAD}"',
  "the protected tar must be structurally validated before extraction",
);
assertAppearsBefore(
  deploySource,
  "validate-extracted",
  "prepare_protected_files",
  "all protected leaves must be validated before backups or mutation",
);
assert.match(deploySource, /prepare_protected_files\(\)/);
assert.match(deploySource, /restore_protected_files\(\)/);
const protectedCapture =
  deploySource.match(/capture_protected_prior\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
assert.match(
  protectedCapture,
  /\[ -e "\$\{protected_path\}" \] \|\| \[ -L "\$\{protected_path\}" \]/,
  "dangling protected-target symlinks must enter the rejection branch",
);
assert.match(deploySource, /assert_protected_path_absent\(\)/);
const absenceCalls =
  deploySource.match(
    /assert_protected_path_absent "\$\{(?:CAPABILITY_NEW|CA_NEW|FINAL_POLICY_NEW|FINAL_TOKEN_NEW|STAGING_SECRET_STAGE|DATABASE_RETIRED|CAPABILITY_BACKUP|CA_BACKUP|FINAL_POLICY_BACKUP|FINAL_TOKEN_BACKUP|DATABASE_BACKUP)\}"/g,
  ) ?? [];
assert.equal(
  absenceCalls.length,
  11,
  "every candidate, retired path, and backup must reject dangling symlinks",
);
assertAppearsBefore(
  deploySource,
  "PROTECTED_PREPARED=true",
  'install -m 0400 "${STAGING_CAPABILITY_ROOT}/action-capability.json"',
  "the common restore must own candidate cleanup before candidate staging",
);
for (const protectedKey of ["CAPABILITY", "CA", "DATABASE", "FINAL_POLICY", "FINAL_TOKEN"]) {
  assert.match(deploySource, new RegExp(`${protectedKey}_CAPTURED`));
}
assert.match(
  deploySource.match(/cleanup_protected_residues\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "",
  /CAPABILITY_NEW[\s\S]*CA_NEW[\s\S]*STAGING_SECRET_STAGE[\s\S]*DATABASE_RETIRED/,
);
assert.match(
  deploySource.match(/early_on_error\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "",
  /restore_protected_files/,
);
assert.match(
  deploySource.match(/^\s*on_error\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "",
  /rollback_runtime[\s\S]*restore_protected_files/,
);
const protectedActivation =
  deploySource.match(/activate_protected_files\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
for (const leaf of [
  "STAGING_SECRET_STAGE",
  "CA_NEW",
  "FINAL_POLICY_NEW",
  "FINAL_TOKEN_NEW",
  "CAPABILITY_NEW",
])
  assert.match(protectedActivation, new RegExp(leaf));
assert.ok(
  protectedActivation.lastIndexOf("CAPABILITY_NEW") >
    protectedActivation.indexOf("FINAL_TOKEN_NEW"),
  "the action capability must activate last",
);
const protectedRestore =
  deploySource.match(/restore_protected_files\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
const protectedCleanup =
  deploySource.match(/cleanup_protected_residues\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
const protectedDiscard =
  deploySource.match(/discard_protected_backups\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
assert.match(deploySource, /PROTECTED_CONTENT_RESTORED=false/);
assert.match(deploySource, /PROTECTED_DEPLOYMENT_COMMITTED=false/);
assert.equal(
  (deploySource.match(/PROTECTED_CONTENT_RESTORED=true/g) ?? []).length,
  1,
  "the restored-content phase marker has one code-owned transition",
);
assert.equal(
  (deploySource.match(/PROTECTED_DEPLOYMENT_COMMITTED=true/g) ?? []).length,
  1,
  "the deployment commit boundary has one code-owned transition",
);
assert.ok(
  protectedRestore.lastIndexOf("action-capability.json") >
    protectedRestore.indexOf("phase3-production-observer-token"),
  "the action capability must restore last",
);
for (const key of ["DATABASE", "CA", "FINAL_POLICY", "FINAL_TOKEN", "CAPABILITY"]) {
  assert.match(
    protectedRestore,
    new RegExp(`restore_protected_object ${key}[^\\n]+\\|\\| return \\$\\?`),
    `${key} restore failure must propagate even when the function is called from ||`,
  );
}
assert.match(
  protectedRestore,
  /PROTECTED_DEPLOYMENT_COMMITTED[^\n]+true[^\n]+return 1/,
  "committed protected content must never enter backup-dependent restore",
);
assert.match(
  protectedRestore,
  /if \[ "\$\{PROTECTED_CONTENT_RESTORED\}" != true \]; then[\s\S]*restore_protected_object DATABASE[\s\S]*restore_protected_object CAPABILITY[\s\S]*sync -f \/etc\/spx-staging \|\| return \$\?[\s\S]*sync -f \/run\/spx-staging-actions \|\| return \$\?[\s\S]*PROTECTED_CONTENT_RESTORED=true[\s\S]*fi[\s\S]*cleanup_protected_residues \|\| return \$\?/,
  "content restore must durably complete before retry-safe cleanup begins",
);
assert.ok(
  protectedRestore.indexOf("PROTECTED_CONTENT_RESTORED=true") <
    protectedRestore.indexOf("cleanup_protected_residues"),
  "backup retirement must start only after restored content is fsynced and phase-marked",
);
assert.match(protectedCleanup, /rm -rf -- "\$\{protected_residue\}" \|\| return \$\?/);
assert.match(
  protectedCleanup,
  /assert_protected_path_absent "\$\{protected_residue\}" \|\| return \$\?/,
);
for (const residue of [
  "CAPABILITY_NEW",
  "CA_NEW",
  "STAGING_SECRET_STAGE",
  "FINAL_POLICY_NEW",
  "FINAL_TOKEN_NEW",
  "DATABASE_RETIRED",
  "DATABASE_BACKUP",
  "CA_BACKUP",
  "FINAL_POLICY_BACKUP",
  "FINAL_TOKEN_BACKUP",
  "CAPABILITY_BACKUP",
])
  assert.match(protectedCleanup, new RegExp(`\\$\\{${residue}:-\\}`));
assert.match(
  protectedRestore,
  /cleanup_protected_residues \|\| return \$\?[\s\S]*sync -f \/etc\/spx-staging \|\| return \$\?[\s\S]*sync -f \/run\/spx-staging-actions \|\| return \$\?[\s\S]*PROTECTED_RESTORED=true[\s\S]*PROTECTED_PREPARED=false/,
  "final cleanup must be durable before the restored/prepared terminal state changes",
);
assert.match(protectedDiscard, /PROTECTED_DEPLOYMENT_COMMITTED[^\n]+true[^\n]+return 1/);
assert.match(
  protectedDiscard,
  /cleanup_protected_residues \|\| return \$\?[\s\S]*sync -f \/etc\/spx-staging \|\| return \$\?[\s\S]*sync -f \/run\/spx-staging-actions \|\| return \$\?[\s\S]*PROTECTED_PREPARED=false/,
  "successful retirement must use the same idempotent cleanup and durable terminal state",
);
assert.match(
  deploySource,
  /PROTECTED_DEPLOYMENT_COMMITTED=true\s*\n\s*discard_protected_backups\s*\n\s*trap - ERR/,
  "deployment becomes committed only after verification and immediately before retirement",
);
const normalError = deploySource.match(/^\s*on_error\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
assert.match(
  normalError,
  /if \[ "\$\{PROTECTED_DEPLOYMENT_COMMITTED\}" = true \]; then[\s\S]*discard_protected_backups \|\| committed_cleanup_status=\$\?[\s\S]*exit "\$\{status\}"[\s\S]*fi[\s\S]*rollback_runtime/,
  "a committed retirement failure may retry cleanup but must exit before rollback",
);
assert.ok(
  normalError.indexOf('exit "${status}"') < normalError.indexOf("rollback_runtime"),
  "the committed cleanup branch must terminate before rollback is reachable",
);
assert.match(
  normalError,
  /restore_protected_files \|\| protected_restore_status=\$\?[\s\S]*if \[ "\$\{protected_restore_status\}" -ne 0 \]; then[\s\S]*restore_protected_files \|\| protected_restore_status=\$\?/,
  "pre-commit recovery retries through the two-phase restore state",
);
const earlyError = deploySource.match(/early_on_error\(\)[\s\S]*?^\s*\}/m)?.[0] ?? "";
assert.match(
  earlyError,
  /PROTECTED_DEPLOYMENT_COMMITTED[\s\S]*discard_protected_backups[\s\S]*else[\s\S]*restore_protected_files/,
  "early recovery must not restore content after the commit boundary",
);
assert.match(deploySource, /discard_protected_backups[\s\S]*trap - ERR/);
assert.doesNotMatch(
  deploySource,
  /systemctl\s+(?:restart|try-restart|reload-or-restart)\s+spx-a3-capacity-(?:guard|watchdog)/,
);
for (const continuousPath of [
  "/etc/spx-staging/production-observer.json",
  "/run/credentials/spx-production-observer-token",
  "/etc/spx-staging/capacity.env",
]) {
  assert.doesNotMatch(
    deploySource,
    new RegExp(
      `(?:install|mv|rm|cp|chmod|chown)[^\\n]*${continuousPath.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`,
    ),
    `${continuousPath} must never be a mutation target`,
  );
}
assert.doesNotMatch(
  deploySource,
  /(?:install|mv|rm|cp|chmod|chown)[^\n]*\/run\/spx-staging-rollout\/[^\n]*\.lease\.json/,
);
assert.match(deploySource, /"\$\{STAGING_SECRET_STAGE\}\/bootstrap\.password"/);
assert.match(deploySource, /"\$\{STAGING_SECRET_STAGE\}\/phase3-control\.password"/);
assert.match(deploySource, /"\$\{STAGING_SECRET_STAGE\}\/principal-\$\{role\}\.password"/);
assert.match(deploySource, /phase3-observer/);
const stagingHandlerInstallCommand =
  '/usr/bin/node "${RELEASE_DIR}/scripts/install-staging-action-handlers.mjs"';
const stagingHandlerInstallLines = deploySource
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.includes("install-staging-action-handlers.mjs"));
assert.deepEqual(stagingHandlerInstallLines, [stagingHandlerInstallCommand]);
assert.match(
  deploySource,
  /if \[ "\$\{TARGET\}" = staging \]; then[\s\S]*\/usr\/bin\/node "\$\{RELEASE_DIR\}\/scripts\/install-staging-action-handlers\.mjs"\s*fi\s*candidate_compose\(\)/,
);
const stagingHandlerInstallIndex = deploySource.indexOf(stagingHandlerInstallCommand);
assert.notEqual(stagingHandlerInstallIndex, -1);
assertAppearsBefore(
  deploySource,
  'mv "${RELEASE_PARENT}.new" "${RELEASE_PARENT}"',
  stagingHandlerInstallCommand,
  "staging handlers must install only after a fresh immutable operator tree is materialized",
);
assertAppearsBefore(
  deploySource,
  'build-operator-bundle.mjs" verify',
  stagingHandlerInstallCommand,
  "staging handlers must install only after an existing immutable operator tree is verified",
);
assert.ok(
  stagingHandlerInstallIndex < deploySource.indexOf("candidate_compose()"),
  "staging handlers must install before Compose or staging action surfaces are reachable",
);
assertAppearsBefore(
  deploySource,
  'systemctl start "${WATCHDOG_UNIT}"',
  "protected-install-watchdog.mjs --action=claim-bootstrap-slot",
  "the host watchdog must be active before the durable DB slot claim",
);
assertAppearsBefore(
  deploySource,
  'docker wait "${MIGRATOR_CONTAINER}"',
  "protected-install-watchdog.mjs --action=claim-bootstrap-slot",
  "the bootstrap slot claim must follow the control-plane migration",
);
assertAppearsBefore(
  deploySource,
  "protected-install-watchdog.mjs --action=claim-bootstrap-slot",
  'mv -Tf "${ACTIVE_PROJECTION}.next" "${ACTIVE_PROJECTION}"',
  "the durable bootstrap claim must be the first protected runtime mutation after migration",
);
assertAppearsBefore(
  deploySource,
  "protected-install-watchdog.mjs --action=claim-bootstrap-slot",
  "for service in ${GRANT_PREFLIGHT_SERVICES}; do",
  "the bootstrap slot must be durable before principal/service preflights",
);
assertAppearsBefore(
  deploySource,
  'EVIDENCE_PATH="${INSTALL_INTENT_EVIDENCE}"',
  'docker start "${MIGRATOR_CONTAINER}"',
  "install intent must be durable before migration starts",
);
assertAppearsBefore(
  deploySource,
  "LIVE_HEALTH_SHA256=",
  '/usr/bin/node "${PROTECTED_INSTALL_PRODUCER_ROOT}/scripts/protected-install-evidence.mjs"',
  "the deterministic state commit cannot start before final health evidence",
);
assert.equal(
  containsHealthyTerminalHostLock(deploySource),
  false,
  "protected install must retain the host lock until Gate 6 admission transfers it",
);
assert.match(
  deploySource,
  /cleanup_candidate_containers\(\) \{[\s\S]*candidate_compose --profile "\*" stop --timeout 120[\s\S]*remove_candidate_labeled_containers[\s\S]*else\s*cleanup_candidate_containers[\s\S]*candidate_compose --profile "\*" ps -q[\s\S]*readlink -f "\$\{ACTIVE_PROJECTION\}"[\s\S]*rm -f "\$\{ACTIVE_PROJECTION\}"[\s\S]*test ! -e "\$\{ACTIVE_PROJECTION\}"/,
  "a failed first install must stop the exact candidate project and remove only its projection",
);
assert.match(
  deploySource,
  /PROTECTED_INSTALL_COMMIT_STARTED=true[\s\S]*\/usr\/bin\/node "\$\{PROTECTED_INSTALL_PRODUCER_ROOT\}\/scripts\/protected-install-evidence\.mjs"/,
);
assert.match(deploySource, /gh attestation verify[\s\S]*release-manifest\.json/);
assert.match(deploySource, /gh attestation verify[\s\S]*operator-bundle\.tar/);
assert.match(deploySource, /gh attestation verify[\s\S]*deployment-target-descriptor\.json/);
assert.match(deploySource, /docker load/);
assert.match(deploySource, /docker create --entrypoint \/bin\/true "\$\{IMAGE_ID\}"/);
assert.match(
  deploySource,
  /docker cp "\$\{RUNTIME_DEPS_CONTAINER\}:\/app\/node_modules" "\$\{RELEASE_PARENT\}\.new\/operator\/node_modules"/,
);
assert.match(deploySource, /test -f "\$\{RELEASE_DIR\}\/node_modules\/mysql2\/package\.json"/);
assertAppearsBefore(
  deploySource,
  'docker cp "${RUNTIME_DEPS_CONTAINER}:/app/node_modules" "${RELEASE_PARENT}.new/operator/node_modules"',
  'chmod -R a-w "${RELEASE_PARENT}.new"',
  "image-bound production dependencies must be materialized before the release becomes immutable",
);
assert.match(
  deploySource,
  /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/trusted-release-artifact\.yml"/,
);
assert.match(
  deploySource,
  /candidate_compose --profile "\*" config --format json > "\$\{COMPOSE_INVENTORY\}"/,
);
assert.match(
  deploySource,
  /node "\$\{INCOMING\}\/operator\/scripts\/container-inventory-check\.mjs"[\s\S]*--container-id="\$\{container\}"/,
);
assert.match(
  deploySource,
  /--compose-json="\$\{COMPOSE_INVENTORY\}"[\s\S]*--policy="\$\{INCOMING\}\/operator\/deploy\/runtime-isolation-policy\.json"/,
);
assert.match(
  deploySource,
  /candidate_compose --profile migration create --force-recreate migrator/,
);
assert.match(
  deploySource,
  /candidate_compose --profile migration run --rm --no-deps[\s\S]*\/tmp\/spx-isolation\/scripts\/container-isolation-probe\.mjs --service=migrator/,
);
assert.match(
  deploySource,
  /docker cp "\$\{RELEASE_DIR\}\/scripts\/container-isolation-probe\.mjs"/,
);
assert.match(deploySource, /docker cp "\$\{RELEASE_DIR\}\/deploy\/runtime-isolation-policy\.json"/);
assert.match(deploySource, /probe_root="\/tmp\/spx-isolation-\$\{OPERATION_ID\}"/);
assert.match(
  deploySource,
  /docker exec --user node "\$\{container\}" node "\$\{probe_root\}\/scripts\/container-isolation-probe\.mjs" --service="\$\{service\}"/,
);
assert.doesNotMatch(
  deploySource,
  /candidate_compose exec -T "\$\{service\}" node scripts\/container-isolation-probe\.mjs/,
);
assert.match(deploySource, /isolation\.ok !== true/);
assert.match(deploySource, /isolation\.failureCodes\.length !== 0/);
assert.match(deploySource, /verify_host_inventory migrator "\$\{MIGRATOR_CONTAINER\}"/);
assert.match(
  deploySource,
  /case "\$\{APPROVED_PRODUCTION_TOPOLOGY\}" in\s*split\) ;; \*\) exit 1 ;;\s*esac/,
  "the current production candidate must be split-only; legacy is rollback-only",
);
assert.match(deploySource, /descriptor\.deploymentUnit !== "primary"/);
assert.match(deploySource, /docker start "\$\{MIGRATOR_CONTAINER\}"/);
assert.match(deploySource, /docker wait "\$\{MIGRATOR_CONTAINER\}"/);
assert.match(
  deploySource,
  /verify_replay_preflight_result\(\)[\s\S]*result\.mode !== "live"[\s\S]*result\.failureCodes\.length !== 0/,
);
assert.doesNotMatch(deploySource, /REPLAY_PREFLIGHT_SERVICES="notifier"/);
assert.match(deploySource, /REPLAY_PREFLIGHT_SERVICES="web-api notification-service line-service"/);
assert.match(
  deploySource,
  /if \[\[ " \$\{SERVICES\} " == \*" realtime-service "\* \]\]; then[\s\S]*REPLAY_PREFLIGHT_SERVICES="\$\{REPLAY_PREFLIGHT_SERVICES\} realtime-service"/,
);
assert.match(
  deploySource,
  /candidate_compose --profile "\*" run --rm --no-deps[\s\S]*-v "\$\{INCOMING\}\/operator\/scripts:\/app\/scripts:ro"[\s\S]*internal-replay-grant-preflight\.mjs/,
);
assert.doesNotMatch(deploySource, /REPLAY_PREFLIGHT_SERVICES="[^"]*ocr-service/);
assert.match(deploySource, /databaseAccountHosts:\s*descriptor\.database\.accountHosts/);
assert.match(
  deploySource,
  /node "\$\{RELEASE_DIR\}\/scripts\/production-topology\.mjs" check "\$\{RELEASE_DIR\}\/deploy\/production-topology\.json"/,
);
assert.match(
  deploySource,
  /SERVICES="\$\(node "\$\{RELEASE_DIR\}\/scripts\/production-topology\.mjs" services "\$\{RELEASE_DIR\}\/deploy\/production-topology\.json" --unit=primary --format=shell\)"/,
);
assert.match(
  deploySource,
  /GRANT_PREFLIGHT_SERVICES="migrator web-api notification-service line-service worker-ptwl-split"/,
);
assert.match(
  deploySource,
  /db-grants-check\.mjs[\s\S]*--role="\$\{service\}"[\s\S]*--expected-account-host="\$\{expected_account_host\}"/,
);
assert.doesNotMatch(deploySource, /GRANT_PREFLIGHT_SERVICES="[^"]*ocr-service/);
assert.match(
  deploySource,
  /docker compose -p spx-production[\s\S]*-f "\$\{RELEASE_DIR\}\/docker-compose\.yml" -f "\$\{RELEASE_DIR\}\/deploy\/production-primary\.yml"/,
);
assert.match(deploySource, /candidate_compose --profile split up -d \$\{SERVICES\}/);
assert.match(deploySource, /candidate_compose stop notifier worker-ifn worker-ptwl worker-ifn-split/);
assert.doesNotMatch(
  deploySource,
  /candidate_compose --profile split up -d web-api notification-service line-service ocr-service worker-ifn-split worker-ptwl-split/,
);
assert.match(
  deploySource,
  /for service in \$\{SERVICES\}; do[\s\S]*verify_host_inventory "\$\{service\}" "\$\{container\}"[\s\S]*deadline=/,
);
assert.ok(
  deploySource.indexOf('verify_host_inventory migrator "${MIGRATOR_CONTAINER}"') <
    deploySource.indexOf("migrator_isolation="),
  "host inventory must pass before the in-container migrator probe",
);
assert.ok(
  deploySource.indexOf("migrator_isolation=") <
    deploySource.indexOf('docker start "${MIGRATOR_CONTAINER}"'),
  "both isolation gates must pass before migration starts",
);
assert.match(deploySource, /imageId/);
assert.match(deploySource, /operatorBundleSha256/);
assert.match(deploySource, /target_descriptor_artifact_id/);
assert.doesNotMatch(deploySource, /target_descriptor_artifact_id[\s\S]{0,500}(?:build|assemble)/i);
assert.match(
  deploySource,
  /verified-release-binding\.json[\s\S]*environment:\s*"supervised-production"[\s\S]*targetDescriptorSha256:[\s\S]*productionIdentityApprovalSha256:/,
  "production projection must carry a canonical release-bound Task 9 identity",
);
const productionBindingIndex = deploySource.indexOf("verified-release-binding.json");
const immutableProjectionIndex = deploySource.indexOf('chmod -R a-w "${RELEASE_PARENT}.new"');
const activateProjectionIndex = deploySource.indexOf(
  'mv -Tf "${ACTIVE_PROJECTION}.next" "${ACTIVE_PROJECTION}"',
);
assert.ok(productionBindingIndex >= 0 && productionBindingIndex < immutableProjectionIndex);
assert.ok(immutableProjectionIndex < activateProjectionIndex);

for (const [file, source] of [
  [".github/workflows/trusted-deploy.yml", deploySource],
  [".github/workflows/trusted-production-project-identity.yml", identitySource],
] as const) {
  assert.match(source, /group:\s*spx-production-mutation/);
  assert.match(
    source,
    /group:\s*spx-production-mutation[\s\S]*cancel-in-progress:\s*false/,
  );
  assert.doesNotMatch(source, /^\s+queue:/m);
  assert.match(source, /cancel-in-progress:\s*false/);
  assertPinnedActions(source, file);
}
assertExactReusableWorkflowPin(
  deployDispatcherSource,
  "deploy-primary",
  "fastest4u/SPX/.github/workflows/trusted-deploy.yml",
);
assertExactReusableWorkflowPin(
  identityDispatcherSource,
  "maintain-identity",
  "fastest4u/SPX/.github/workflows/trusted-production-project-identity.yml",
);
assert.deepEqual(jobPermissions(deployDispatcherSource, "deploy-primary"), {
  actions: "read",
  attestations: "write",
  contents: "read",
  "id-token": "write",
});
assert.deepEqual(jobPermissions(identityDispatcherSource, "maintain-identity"), {
  actions: "read",
  contents: "read",
});
assert.deepEqual(jobPermissions(deploySource, "verify-release"), {
  actions: "read",
  attestations: "write",
  contents: "read",
  "id-token": "write",
});
assert.deepEqual(jobPermissions(identitySource, "maintain-identity"), {
  actions: "read",
  contents: "read",
});
assertPinnedActions(releaseSource, ".github/workflows/release-artifact.yml");
assertPinnedActions(trustedReleaseSource, ".github/workflows/trusted-release-artifact.yml");

const composeCommands = extractComposeCommands(deploySource);
for (const command of composeCommands) {
  assert.match(
    command,
    /docker compose -p (?:spx-production|spx-staging|"?\$\{SPX_PRODUCTION_COMPOSE_PROJECT\}"?)/,
    `compose command must use a canonical project literal: ${command}`,
  );
  for (const variable of [
    "SPX_RELEASE_SHA",
    "SPX_TARGET_DESCRIPTOR_SHA256",
    "SPX_OPERATOR_BUNDLE_SHA256",
    "SPX_RUNTIME_ENVIRONMENT",
    "SPX_STAGING_RUN_ID",
  ]) {
    assert.match(
      command,
      new RegExp(`${variable}=`),
      `${variable} must bind every Compose command: ${command}`,
    );
  }
  if (/-p spx-staging\b/.test(command)) {
    assert.match(command, /-f "\$\{(?:CURRENT_RELEASE|RELEASE_DIR)\}\/docker-compose\.yml"/);
    assert.match(
      command,
      /-f "\$\{(?:CURRENT_RELEASE|RELEASE_DIR)\}\/docker-compose\.staging\.yml"/,
    );
  }
  if (/-p spx-production\b/.test(command)) {
    assert.doesNotMatch(command, /docker-compose\.staging\.yml/);
  }
}
assert.ok(composeCommands.some((command) => /-p spx-production\b/.test(command)));
assert.ok(composeCommands.some((command) => /-p spx-staging\b/.test(command)));

assert.match(releaseSource, /source_sha:/);
assert.match(releaseSource, /\^\[0-9a-f\]\{40\}\$/);
assert.match(releaseSource, /git rev-parse HEAD/);
assert.match(releaseSource, /build-candidate:/);
assert.match(
  releaseSource,
  /sign-release:[\s\S]*needs:\s*build-candidate[\s\S]*uses:\s*fastest4u\/SPX\/\.github\/workflows\/trusted-release-artifact\.yml@[0-9a-f]{40}/,
);
assert.match(
  releaseSource,
  /build-candidate:[\s\S]*?permissions:\s*\n\s*contents:\s*read\s*\n[\s\S]*?steps:/,
);
const candidateJob = releaseSource.match(/\n {2}build-candidate:[\s\S]*?\n {2}sign-release:/)?.[0];
assert.ok(candidateJob);
assert.match(candidateJob, /npx --no-install playwright install --with-deps chromium/);
assertAppearsBefore(
  candidateJob,
  "npm ci",
  "npx --no-install playwright install --with-deps chromium",
  "release candidate must install the locked Playwright browser after dependencies",
);
assertAppearsBefore(
  candidateJob,
  "npx --no-install playwright install --with-deps chromium",
  "npm test",
  "release candidate must install Playwright before browser regression tests",
);
assert.deepEqual(jobPermissions(releaseSource, "build-candidate"), { contents: "read" });
assert.doesNotMatch(candidateJob, /attestations:\s*write|id-token:\s*write/);
assert.doesNotMatch(releaseSource, /environment:\s*release/);
const releaseCallJob = releaseSource.match(/\n {2}sign-release:[\s\S]*$/)?.[0];
assert.ok(releaseCallJob);
assert.doesNotMatch(releaseCallJob, /\bruns-on:|^\s+steps:|\benvironment:/m);
assert.match(trustedReleaseSource, /workflow_call:/);
assert.match(trustedReleaseSource, /environment:\s*release/);
assert.match(trustedReleaseSource, /WORKFLOW_SHA:\s*\$\{\{ job\.workflow_sha \}\}/);
assert.match(trustedReleaseSource, /ref:\s*\$\{\{ job\.workflow_sha \}\}/);
assert.match(trustedReleaseSource, /path:\s*trusted/);
assert.match(trustedReleaseSource, /download-artifact@[0-9a-f]{40}/);
assert.match(releaseSource, /docker build[\s\S]*--iidfile/);
assert.match(releaseSource, /--build-arg SPX_SOURCE_SHA=\$\{SOURCE_SHA\}/);
assert.match(releaseSource, /--schema-min=33/);
assert.doesNotMatch(releaseSource, /--schema-min=31/);
assert.match(releaseSource, /create-release-manifest\.mjs/);
assert.match(releaseSource, /build-operator-bundle\.mjs/);
assert.match(trustedReleaseSource, /attest-build-provenance@[0-9a-f]{40}/);
assert.match(releaseSource, /upload-artifact@[0-9a-f]{40}/);
assert.match(trustedReleaseSource, /release-manifest\.json/);
assert.match(trustedReleaseSource, /operator-bundle\.index\.json/);
assert.match(trustedReleaseSource, /operator-bundle\.tar/);
assert.match(trustedReleaseSource, /bootstrap\/scripts\/deployment-target-descriptor\.mjs/);
assert.match(trustedReleaseSource, /bootstrap\/src\/services\/deployment-target-descriptor\.ts/);
assert.match(trustedReleaseSource, /bootstrap\/src\/services\/release-manifest\.ts/);
assert.match(trustedReleaseSource, /spx-image\.tar/);
assert.doesNotMatch(trustedReleaseSource, /deployment-target-descriptor\.mjs\s+(?:build|assemble)/);
assert.doesNotMatch(trustedReleaseSource, /deployment-target-descriptor\.json/);

assert.doesNotMatch(identitySource, /db:migrate|migrator|docker load|docker build|compose build/);
assert.match(
  deploySource,
  /node verified\/release\/bootstrap\/scripts\/deployment-target-descriptor\.mjs verify/,
);
assert.doesNotMatch(
  deploySource,
  /node verified\/operator\/scripts\/deployment-target-descriptor\.mjs verify/,
);
assert.match(identitySource, /production-project-identity\.mjs --action=\$\{ACTION\}/);
assert.match(identitySource, /production-mutation-host-lock\.mjs --action=acquire/);
assert.match(identitySource, /SPX_KNOWN_HOSTS_SHA256/);
assert.match(identitySource, /sha256sum ~\/\.ssh\/known_hosts/);
assert.match(identitySource, /KNOWN_HOST_LOOKUP/);
assert.match(
  identitySource,
  /systemd-run[\s\S]*production-project-identity\.mjs[\s\S]*--action=reconcile/,
);
assert.match(identitySource, /Restart=always/);
assert.match(identitySource, /systemctl stop "\$\{WATCHDOG_UNIT\}"/);
assert.equal(
  packageManifest.scripts["service:production-project-identity"],
  "node scripts/production-project-identity.mjs",
);
assert.equal(
  packageManifest.scripts["service:production-mutation-host-lock"],
  "node scripts/production-mutation-host-lock.mjs",
);

console.log("deploy release workflow tests passed");
