import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bootstrapDenySha = "0".repeat(40);

function readWorkflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, "utf8");
}

function assertNoInputExpressionInRunBlocks(source: string, workflowName: string): void {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const leading = /^\s*/.exec(line)?.[0].length ?? 0;
      if (line.trim().length > 0 && leading <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    assert.doesNotMatch(
      body.join("\n"),
      /\$\{\{\s*(?:inputs|github\.event\.inputs)\./,
      `${workflowName} must pass untrusted inputs through env before shell validation`,
    );
  }
}

function assertAttestationsPinProducer(source: string, workflowName: string): void {
  const commands = source
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .filter((line) => /gh attestation verify/.test(line));
  assert.ok(commands.length > 0, `${workflowName} must verify input attestations`);
  for (const command of commands) {
    assert.match(
      command,
      /(?:^|\s)-R\s+/,
      `${workflowName} must scope verification to the repository`,
    );
    assert.doesNotMatch(command, /--repo\s+/, `${workflowName} must use the audited -R form`);
    assert.match(command, /--signer-workflow\s+/, `${workflowName} must pin the producer workflow`);
    assert.match(
      command,
      /--signer-digest\s+/,
      `${workflowName} must pin the producer workflow SHA`,
    );
    assert.match(
      command,
      /--deny-self-hosted-runners/,
      `${workflowName} must reject self-hosted attestation producers`,
    );
  }
}

function assertExactArtifactAndAttestationRunBinding(source: string, workflowName: string): void {
  assert.match(source, /scripts\/lib\/github-attestation-run\.mjs/);
  assert.match(
    source,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/artifacts\/\$\{artifact_id\}"/,
    `${workflowName} must fetch authoritative metadata for the selected artifact ID`,
  );
  assert.match(source, /artifactId:\(\.id\|tostring\)/);
  assert.match(source, /workflowHeadSha:\.workflow_run\.head_sha/);
  assert.match(source, /workflowRepositoryId:\(\.workflow_run\.repository_id\|tostring\)/);
  assert.match(source, /workflowRunId:\(\.workflow_run\.id\|tostring\)/);
  assert.match(
    source,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{authoritative_run_id\}"/,
    `${workflowName} must fetch the authoritative attempt for the artifact's run`,
  );
  assert.match(source, /\.run_attempt \| tostring/);
  assert.match(source, /workflowRunAttempt/);
  assert.match(source, /--artifact-id="\$\{artifact_id\}"/);
  assert.match(source, /--run-id="\$\{run_id\}"/);
  assert.match(source, /--artifact-metadata="\$\{artifact_metadata\}"/);
  assert.match(source, /--attestation-results="\$\{attestation_results\}"/);
  assert.match(source, /--repository="\$\{GITHUB_REPOSITORY\}"/);
  assert.match(source, /--signer-workflow="\$\{signer_workflow\}"/);
  assert.match(source, /--signer-sha="\$\{signer_sha\}"/);
  assert.match(
    source,
    /--format\s+json/,
    `${workflowName} must expose verified certificate claims for exact run binding`,
  );
}

function assertProtectedProducerMapConsumer(
  source: string,
  workflowName: string,
  mappings: ReadonlyArray<readonly [kind: string, root: string]>,
): void {
  assert.match(source, /deploy\/protected-evidence-producers\.json/);
  assert.match(source, /scripts\/lib\/evidence-artifact\.mjs/);
  assert.match(source, /scripts\/lib\/protected-evidence-producers\.mjs/);
  assert.match(source, /producer\.bootstrapDenied\s*!==\s*false/);
  assert.match(source, /\^0\{40\}\$/);
  assert.match(source, /\^0\{64\}\$/);
  assert.match(source, /workflow_file_sha256/);
  const resolveIndex = source.indexOf("producerFor(");
  const downloadIndex = source.indexOf("actions/download-artifact@");
  assert.ok(resolveIndex >= 0, `${workflowName} must resolve a reviewed producer`);
  assert.ok(
    downloadIndex < 0 || resolveIndex < downloadIndex,
    `${workflowName} must reject bootstrap-denied pins before downloading artifacts`,
  );
  for (const [kind, root] of mappings) {
    const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const resolvesLiteral = new RegExp(`producerFor\\(\\s*["']${escapedKind}["']\\s*\\)`).test(
      source,
    );
    const resolvesMappedKind =
      /producerFor\(\s*kind\s*\)/.test(source) && new RegExp(`["']${escapedKind}["']`).test(source);
    assert.equal(
      resolvesLiteral || resolvesMappedKind,
      true,
      `${workflowName} must resolve the ${kind} producer from the reviewed map`,
    );
    assert.match(
      source,
      new RegExp(
        `assertProtectedEvidenceFileSet\\(\\s*["']${escapedKind}["']\\s*,\\s*["']${escapedRoot}["']`,
      ),
      `${workflowName} must enforce the exact ${kind} protected file set at ${root}`,
    );
  }
}

function assertExactReusableDispatcher(dispatcherName: string, reusableName: string): string {
  const source = readWorkflow(dispatcherName);
  assert.match(source, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(source, /\bruns-on:|^\s+steps:/m);
  assert.doesNotMatch(source, /\benvironment:|\$\{\{\s*secrets\.|secrets:\s*inherit/);
  assert.doesNotMatch(source, /\b(?:ssh|scp|docker)\b|SPX_SSH_KEY|SPX_KNOWN_HOSTS/);
  assert.doesNotMatch(source, /uses:\s+\.\/\.github\/workflows\//);
  const escaped = reusableName.replaceAll(".", "\\.");
  const match = source.match(
    new RegExp(`uses:\\s+fastest4u/SPX/\\.github/workflows/${escaped}@([0-9a-f]{40})`),
  );
  assert.ok(match, `${dispatcherName} must delegate through an immutable full SHA`);
  if (match[1] === bootstrapDenySha) assert.match(source, /BOOTSTRAP-DENY/);
  return match[1];
}

function assertProtectedOidcSigner(
  workflowName: string,
  audience: string,
  expectedShaVariable: string,
  signerUrlVariable: string,
  keyIdVariable: string,
): void {
  const source = readWorkflow(workflowName);
  assert.match(source, /on:\s*\n\s*workflow_call:/);
  assert.doesNotMatch(source, /workflow_dispatch:/);
  assert.match(source, /environment:\s*production/);
  assert.match(
    source,
    /concurrency:[\s\S]*group:\s*spx-production-mutation[\s\S]*queue:\s*max[\s\S]*cancel-in-progress:\s*false/,
  );
  assert.match(source, /id-token:\s*write/);
  assert.match(source, /attestations:\s*write/);
  assert.match(source, /\$\{\{\s*job\.workflow_sha\s*\}\}/);
  assert.match(source, new RegExp(expectedShaVariable));
  assert.match(source, new RegExp(signerUrlVariable));
  assert.match(source, new RegExp(keyIdVariable));
  assert.match(source, new RegExp(`audience=${audience}`));
  assert.match(source, /job_workflow_ref/);
  assert.match(source, /job_workflow_sha/);
  assert.match(source, /environment:production/);
  assert.match(source, /curl[\s\S]*--proto\s+'=https'[\s\S]*--tlsv1\.2/);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./);
  for (const action of [
    "actions/checkout",
    "actions/download-artifact",
    "actions/attest-build-provenance",
    "actions/upload-artifact",
  ]) {
    assert.match(source, new RegExp(`${action.replace("/", "\\/")}@[0-9a-f]{40}`));
  }
}

const approvalPin = assertExactReusableDispatcher(
  "gate6-approval.yml",
  "gate6-envelope-signer.yml",
);
const linePin = assertExactReusableDispatcher(
  "gate6-line-permit.yml",
  "gate6-line-permit-signer.yml",
);
const ocrPin = assertExactReusableDispatcher("gate6-ocr-permit.yml", "gate6-ocr-permit-signer.yml");
const postproofPin = assertExactReusableDispatcher(
  "gate6-postproof-principal.yml",
  "gate6-postproof-principal-signer.yml",
);
const runtimePin = assertExactReusableDispatcher("gate6-runtime.yml", "gate6-runtime-executor.yml");
const acceptedEvidencePin = assertExactReusableDispatcher(
  "gate6-accepted-evidence.yml",
  "gate6-accepted-evidence-exporter.yml",
);
const finalVerifierPin = assertExactReusableDispatcher(
  "gate6-final-verifier.yml",
  "gate6-final-verifier-exporter.yml",
);

assertProtectedOidcSigner(
  "gate6-envelope-signer.yml",
  "spx-gate6",
  "SPX_TRUSTED_GATE6_ENVELOPE_SIGNER_SHA",
  "SPX_GATE6_ENVELOPE_SIGNER_URL",
  "SPX_GATE6_ENVELOPE_KEY_ID",
);
assertProtectedOidcSigner(
  "gate6-line-permit-signer.yml",
  "spx-gate6-line-permit",
  "SPX_TRUSTED_GATE6_LINE_PERMIT_SIGNER_SHA",
  "SPX_GATE6_LINE_PERMIT_SIGNER_URL",
  "SPX_GATE6_LINE_PERMIT_KEY_ID",
);
assertProtectedOidcSigner(
  "gate6-ocr-permit-signer.yml",
  "spx-gate6-ocr-permit",
  "SPX_TRUSTED_GATE6_OCR_PERMIT_SIGNER_SHA",
  "SPX_GATE6_OCR_PERMIT_SIGNER_URL",
  "SPX_GATE6_OCR_PERMIT_KEY_ID",
);
assertProtectedOidcSigner(
  "gate6-postproof-principal-signer.yml",
  "spx-gate6-postproof-principal",
  "SPX_TRUSTED_GATE6_POSTPROOF_SIGNER_SHA",
  "SPX_GATE6_POSTPROOF_SIGNER_URL",
  "SPX_GATE6_POSTPROOF_KEY_ID",
);

const lineDispatcher = readWorkflow("gate6-line-permit.yml");
const ocrDispatcher = readWorkflow("gate6-ocr-permit.yml");
for (const source of [lineDispatcher, ocrDispatcher]) {
  assert.doesNotMatch(
    source,
    /^\s{6}(?:service|kind|team_id|target_sha256|fixture_sha256|ttl|scope|action_id):/m,
    "permit dispatchers must derive mutation details from signed artifacts",
  );
}

const postproofDispatcher = readWorkflow("gate6-postproof-principal.yml");
assert.doesNotMatch(
  postproofDispatcher,
  /^\s{6}(?:sql|account|grant|scope|action_id|ttl|evidence_sha256):/m,
  "post-proof dispatcher must not choose principal mutation details",
);

const postproofSigner = readWorkflow("gate6-postproof-principal-signer.yml");
assertExactArtifactAndAttestationRunBinding(
  postproofSigner,
  "gate6-postproof-principal-signer.yml",
);
assert.match(postproofSigner, /db-principal-revoke-legacy/);
assert.match(postproofSigner, /db-principal-restore-legacy/);
assert.match(postproofSigner, /actions-postproof/);
assert.match(postproofSigner, /paired/i);

for (const workflowName of ["gate6-line-permit-signer.yml", "gate6-ocr-permit-signer.yml"]) {
  const source = readWorkflow(workflowName);
  assertExactArtifactAndAttestationRunBinding(source, workflowName);
  assertProtectedProducerMapConsumer(source, workflowName, [
    ["accepted-db-transition", "inert-inputs/stage"],
  ]);
  assert.match(source, /accepted-db-transition-evidence\.json/);
  assert.doesNotMatch(source, /SPX_TRUSTED_GATE6_ACCEPTED_EVIDENCE_EXPORTER_SHA/);
  assert.match(
    source,
    /PROTECTED_SIGNER_WORKFLOW:\s*\$\{\{\s*steps\.protected-producer\.outputs\.workflow/,
  );
  assert.match(
    source,
    /PROTECTED_SIGNER_SHA:\s*\$\{\{\s*steps\.protected-producer\.outputs\.signer_sha/,
  );
  assert.match(source, /accepted\.value\.candidateSha\s*!==\s*process\.env\.CANDIDATE_SHA/);
  assert.match(source, /accepted\.value\.gate6Id\s*!==\s*envelope\.gate6Id/);
  assert.match(source, /accepted\.value\.phase\s*!==\s*"db-transition"/);
  assert.match(source, /accepted\.value\.scope\s*!==\s*"stage-accept-db-transition"/);
  assert.match(source, /accepted\.value\.currentStage\s*!==\s*"db-transition-stable"/);
  assert.match(source, /accepted\.value\.actionStatus\s*!==\s*"succeeded"/);
  assert.match(source, /accepted\.value\.acceptedCheckerName\s*!==\s*accepted\.value\.checkerName/);
  assert.match(source, /accepted\.value\.receiptSha256/);
  assert.match(source, /accepted\.sha256\s*!==\s*process\.env\.EXPECTED_PROTECTED_SHA256/);
  assert.match(
    source,
    /EXPECTED_PROTECTED_SHA256:\s*\$\{\{\s*steps\.verified-inputs\.outputs\.protected_sha256/,
  );
  assert.doesNotMatch(source, /gate6-runtime-executor\.yml/);
}
assertProtectedProducerMapConsumer(postproofSigner, "gate6-postproof-principal-signer.yml", [
  ["accepted-pre-close", "inert-inputs/preclose"],
]);
assert.match(postproofSigner, /accepted-pre-close-evidence\.json/);
assert.doesNotMatch(postproofSigner, /SPX_TRUSTED_GATE6_ACCEPTED_EVIDENCE_EXPORTER_SHA/);
assert.match(
  postproofSigner,
  /PROTECTED_SIGNER_WORKFLOW:\s*\$\{\{\s*steps\.protected-producer\.outputs\.workflow/,
);
assert.match(
  postproofSigner,
  /PROTECTED_SIGNER_SHA:\s*\$\{\{\s*steps\.protected-producer\.outputs\.signer_sha/,
);
assert.match(postproofSigner, /accepted\.value\.candidateSha\s*!==\s*process\.env\.CANDIDATE_SHA/);
assert.match(postproofSigner, /accepted\.value\.gate6Id\s*!==\s*envelope\.gate6Id/);
assert.match(postproofSigner, /accepted\.value\.phase\s*!==\s*"pre-close"/);
assert.match(postproofSigner, /accepted\.value\.scope\s*!==\s*"stage-accept-pre-close"/);
assert.match(postproofSigner, /accepted\.value\.currentStage\s*!==\s*"pre-close-accepted"/);
assert.match(postproofSigner, /accepted\.value\.preCloseSafety\?\.activePermitCount\s*!==\s*0/);
assert.match(postproofSigner, /accepted\.value\.preCloseSafety\?\.uncompensatedWork\s*!==\s*0/);
assert.match(postproofSigner, /accepted\.sha256\s*!==\s*process\.env\.EXPECTED_PROTECTED_SHA256/);
assert.match(
  postproofSigner,
  /EXPECTED_PROTECTED_SHA256:\s*\$\{\{\s*steps\.verified-inputs\.outputs\.protected_sha256/,
);
assert.doesNotMatch(postproofSigner, /gate6-runtime-executor\.yml/);

const envelopeSigner = readWorkflow("gate6-envelope-signer.yml");
assertExactArtifactAndAttestationRunBinding(envelopeSigner, "gate6-envelope-signer.yml");
assertProtectedProducerMapConsumer(envelopeSigner, "gate6-envelope-signer.yml", [
  ["staging-gates", "inert-inputs/staging-gates"],
  ["production-backup-restore", "inert-inputs/backup"],
  ["protected-install", "inert-inputs/protected-install"],
]);
assert.match(envelopeSigner, /\["staging",\s*"staging-gates"\]/);
assert.match(envelopeSigner, /\["backup",\s*"production-backup-restore"\]/);
assert.match(envelopeSigner, /\["install",\s*"protected-install"\]/);
assert.match(
  envelopeSigner,
  /STAGING_PRODUCER_WORKFLOW:\s*\$\{\{\s*steps\.protected-producers\.outputs\.staging_workflow/,
);
assert.match(
  envelopeSigner,
  /BACKUP_PRODUCER_WORKFLOW:\s*\$\{\{\s*steps\.protected-producers\.outputs\.backup_workflow/,
);
assert.match(
  envelopeSigner,
  /INSTALL_PRODUCER_WORKFLOW:\s*\$\{\{\s*steps\.protected-producers\.outputs\.install_workflow/,
);
assert.doesNotMatch(envelopeSigner, /TRUSTED_DEPLOY_SIGNER_SHA/);
assert.match(envelopeSigner, /readExactCanonicalFile/);
assert.match(envelopeSigner, /stagingEvidence\?\.releaseManifestSha256\s*!==\s*release\.sha256/);
assert.match(
  envelopeSigner,
  /backupEvidence\?\.targetDescriptorSha256\s*!==\s*productionTarget\.sha256/,
);
assert.match(envelopeSigner, /backupSignature\?\.subjectSha256/);
assert.match(
  envelopeSigner,
  /installEvidence\?\.backupRestoreEvidenceSha256\s*!==\s*backupEvidenceFile\?\.sha256/,
);
assert.match(envelopeSigner, /installSignature\?\.subjectSha256/);
for (const exactRequestFile of [
  "build-manifest.json",
  "operator-bundle.index.json",
  "release-artifact.index.json",
  "release-manifest.json",
  "deployment-target-descriptor.attestation-claims.json",
  "deployment-target-descriptor.json",
]) {
  assert.match(envelopeSigner, new RegExp(exactRequestFile.replaceAll(".", "\\.")));
}
assert.match(envelopeSigner, /files\.length\s*!==\s*13/);
assert.match(envelopeSigner, /EXPECTED_SUBJECT_SET_SHA256/);
assert.match(envelopeSigner, /sha256sum --check --strict signer-inputs\.sha256/);
assert.doesNotMatch(envelopeSigner, /\b(?:await\s+)?walk\s*\(\s*["']inert-inputs/);

const runtimeExecutor = readWorkflow("gate6-runtime-executor.yml");
assertExactArtifactAndAttestationRunBinding(runtimeExecutor, "gate6-runtime-executor.yml");
assertProtectedProducerMapConsumer(runtimeExecutor, "gate6-runtime-executor.yml", [
  ["final-verifier", "verified-input/final-verifier"],
]);
assert.match(runtimeExecutor, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(runtimeExecutor, /workflow_dispatch:/);
assert.match(runtimeExecutor, /environment:\s*production/);
assert.match(runtimeExecutor, /group:\s*spx-production-mutation/);
assert.match(
  runtimeExecutor,
  /group:\s*spx-production-mutation[\s\S]*queue:\s*max[\s\S]*cancel-in-progress:\s*false/,
);
assert.match(runtimeExecutor, /cancel-in-progress:\s*false/);
assert.match(
  runtimeExecutor,
  /admit\|permit-register-line\|permit-register-ocr\|postproof-register\|abort\|seal-close\|release/,
);
assert.match(runtimeExecutor, /SPX_SSH_KEY/);
assert.match(runtimeExecutor, /SPX_KNOWN_HOSTS/);
assert.match(runtimeExecutor, /SPX_HOST/);
assert.match(runtimeExecutor, /TRUSTED_WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(runtimeExecutor, /SPX_TRUSTED_GATE6_RUNTIME_EXECUTOR_SHA/);
assert.match(runtimeExecutor, /test "\$\{TRUSTED_WORKFLOW_SHA\}" = "\$\{EXPECTED_WORKFLOW_SHA\}"/);
assert.match(runtimeExecutor, /gate6-runtime-control\.mjs/);
assert.match(runtimeExecutor, /final_verifier_artifact_id/);
assert.match(runtimeExecutor, /final_verifier_run_id/);
assert.doesNotMatch(runtimeExecutor, /SPX_TRUSTED_GATE6_FINAL_VERIFIER_EXPORTER_SHA/);
assert.match(
  runtimeExecutor,
  /FINAL_VERIFIER_WORKFLOW:\s*\$\{\{\s*steps\.final-producer\.outputs\.workflow/,
);
assert.match(
  runtimeExecutor,
  /FINAL_VERIFIER_SIGNER_SHA:\s*\$\{\{\s*steps\.final-producer\.outputs\.sha/,
);
assert.match(runtimeExecutor, /release\?\.scope\s*!==\s*"gate6-release"/);
assert.match(runtimeExecutor, /verifier\.evidence\?\.phase\s*!==\s*"final"/);
assert.match(runtimeExecutor, /verifier\.evidence\?\.candidateSha\s*!==\s*release\.candidateSha/);
assert.match(runtimeExecutor, /verifier\.evidence\?\.gate6Id\s*!==\s*release\.gate6Id/);
assert.match(runtimeExecutor, /verifier\.evidence\?\.terminalEvidenceSha256/);
assert.match(runtimeExecutor, /verifier\.evidenceSha256\s*!==\s*createHash\("sha256"\)/);
assert.match(runtimeExecutor, /expected_final_sha256="\$\(sha256sum/);
assert.match(runtimeExecutor, /"\$\{expected_final_sha256\}"/);
assert.doesNotMatch(
  runtimeExecutor,
  /signer_workflow="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/gate6-runtime-executor\.yml"/,
);
assert.match(runtimeExecutor, /test "\$\{#delivery_files\[@\]\}" -eq 2/);
assert.doesNotMatch(runtimeExecutor, /secrets:\s*inherit/);

for (const workflowName of [
  "gate6-accepted-evidence-exporter.yml",
  "gate6-envelope-signer.yml",
  "gate6-line-permit-signer.yml",
  "gate6-ocr-permit-signer.yml",
  "gate6-postproof-principal-signer.yml",
  "gate6-final-verifier-exporter.yml",
  "gate6-runtime-executor.yml",
]) {
  assertNoInputExpressionInRunBlocks(readWorkflow(workflowName), workflowName);
  assertAttestationsPinProducer(readWorkflow(workflowName), workflowName);
}

const consumerPins = [approvalPin, linePin, ocrPin, postproofPin, runtimePin];
assert.equal(
  new Set(consumerPins).size,
  1,
  "all protected-evidence consumer dispatchers must pin the map-authorization snapshot",
);
const producerPins = [acceptedEvidencePin, finalVerifierPin];
assert.equal(
  new Set(producerPins).size,
  1,
  "all protected-evidence producer dispatchers must pin the producer snapshot",
);
const pins = [
  approvalPin,
  linePin,
  ocrPin,
  postproofPin,
  runtimePin,
  acceptedEvidencePin,
  finalVerifierPin,
];
if (pins.some((pin) => pin === bootstrapDenySha)) {
  assert.ok(pins.every((pin) => pin === bootstrapDenySha));
} else {
  assert.notEqual(
    consumerPins[0],
    producerPins[0],
    "activated consumers must read the map snapshot that authorizes the earlier producer SHA",
  );
}

console.log("Gate 6 production workflow trust tests passed");
