import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const dispatcherPath = ".github/workflows/gate6-accepted-evidence.yml";
const reusablePath = ".github/workflows/gate6-accepted-evidence-exporter.yml";

assert.equal(existsSync(dispatcherPath), true, "the accepted-evidence dispatcher must exist");
assert.equal(existsSync(reusablePath), true, "the trusted accepted-evidence exporter must exist");

const dispatcher = readFileSync(dispatcherPath, "utf8");
const reusable = readFileSync(reusablePath, "utf8");

function inputNames(source: string, trigger: "workflow_dispatch" | "workflow_call"): string[] {
  const lines = source.split(/\r?\n/);
  const triggerIndex = lines.findIndex((line) => line === `  ${trigger}:`);
  assert.notEqual(triggerIndex, -1, `${trigger} must be declared`);
  const inputsIndex = lines.findIndex(
    (line, index) => index > triggerIndex && line === "    inputs:",
  );
  assert.notEqual(inputsIndex, -1, `${trigger} inputs must be declared`);
  const names: string[] = [];
  for (let index = inputsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= 4) break;
    const input = /^ {6}([a-z0-9_]+):\s*$/.exec(line);
    if (input) names.push(input[1]);
  }
  return names;
}

function jobPermissions(source: string, jobName: string): Record<string, string> {
  const lines = source.split(/\r?\n/);
  const jobIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(jobIndex, -1, `${jobName} job must exist`);
  const permissionsIndex = lines.findIndex(
    (line, index) => index > jobIndex && line === "    permissions:",
  );
  assert.notEqual(permissionsIndex, -1, `${jobName} must declare explicit job permissions`);
  const result: Record<string, string> = {};
  for (let index = permissionsIndex + 1; index < lines.length; index += 1) {
    const permission = /^ {6}([a-z-]+):\s*([^\s#]+)\s*$/.exec(lines[index]);
    if (!permission) break;
    result[permission[1]] = permission[2];
  }
  return result;
}

assert.match(dispatcher, /^permissions:\s*\{\}\s*$/m);
assert.match(dispatcher, /on:\s*\n {2}workflow_dispatch:/);
assert.doesNotMatch(dispatcher, /workflow_call:/);
assert.deepEqual(inputNames(dispatcher, "workflow_dispatch"), [
  "phase",
  "candidate_sha",
  "approval_artifact_id",
  "approval_run_id",
]);
assert.match(
  dispatcher,
  /phase:[\s\S]*type:\s*choice[\s\S]*options:\s*\n\s*- db-transition\s*\n\s*- pre-close/,
);
for (const name of ["candidate_sha", "approval_artifact_id", "approval_run_id"]) {
  assert.match(
    dispatcher,
    new RegExp(`${name}:[\\s\\S]*?required:\\s*true[\\s\\S]*?type:\\s*string`),
  );
}
assert.doesNotMatch(dispatcher, /\bruns-on:|^\s+steps:|\benvironment:/m);
assert.doesNotMatch(dispatcher, /\$\{\{\s*secrets\.|secrets:\s*inherit/);
assert.doesNotMatch(dispatcher, /\b(?:ssh|scp|docker)\b/);
assert.match(dispatcher, /BOOTSTRAP-DENY/);
assert.match(
  dispatcher,
  /uses:\s*fastest4u\/SPX\/\.github\/workflows\/gate6-accepted-evidence-exporter\.yml@0000000000000000000000000000000000000000/,
);
assert.deepEqual(jobPermissions(dispatcher, "export-accepted-evidence"), {
  actions: "read",
  attestations: "write",
  contents: "read",
  "id-token": "write",
});
for (const name of ["phase", "candidate_sha", "approval_artifact_id", "approval_run_id"]) {
  assert.match(dispatcher, new RegExp(`${name}:\\s*\\$\\{\\{ inputs\\.${name} \\}\\}`));
}

assert.match(reusable, /^permissions:\s*\{\}\s*$/m);
assert.match(reusable, /on:\s*\n {2}workflow_call:/);
assert.doesNotMatch(reusable, /workflow_dispatch:/);
assert.deepEqual(inputNames(reusable, "workflow_call"), [
  "phase",
  "candidate_sha",
  "approval_artifact_id",
  "approval_run_id",
]);
for (const name of ["phase", "candidate_sha", "approval_artifact_id", "approval_run_id"]) {
  assert.match(
    reusable,
    new RegExp(`${name}:[\\s\\S]*?required:\\s*true[\\s\\S]*?type:\\s*string`),
  );
}
assert.match(reusable, /environment:\s*production/);
assert.match(
  reusable,
  /concurrency:[\s\S]*group:\s*spx-production-mutation[\s\S]*queue:\s*max[\s\S]*cancel-in-progress:\s*false/,
);
assert.deepEqual(jobPermissions(reusable, "export-accepted-evidence"), {
  actions: "read",
  attestations: "write",
  contents: "read",
  "id-token": "write",
});

for (const action of [
  "actions/checkout",
  "actions/download-artifact",
  "actions/attest-build-provenance",
  "actions/upload-artifact",
]) {
  assert.match(reusable, new RegExp(`${action.replace("/", "\\/")}@[0-9a-f]{40}`));
}
assert.match(reusable, /ref:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.doesNotMatch(reusable, /ref:\s*\$\{\{\s*inputs\.candidate_sha\s*\}\}/);
assert.match(reusable, /SPX_TRUSTED_GATE6_ACCEPTED_EVIDENCE_EXPORTER_SHA/);
assert.match(reusable, /SPX_GATE6_ACCEPTED_EVIDENCE_EXPORTER_WORKFLOW_SHA256/);
assert.match(reusable, /SPX_GATE6_ACCEPTED_EVIDENCE_EXPORTER_MODULE_SHA256/);
assert.match(reusable, /trusted\/\.github\/workflows\/gate6-accepted-evidence-exporter\.yml/);
assert.match(reusable, /trusted\/scripts\/gate6-accepted-evidence-export\.mjs/);
assert.match(reusable, /sha256sum[\s\S]*gate6-accepted-evidence-exporter\.yml/);
assert.match(reusable, /sha256sum[\s\S]*gate6-accepted-evidence-export\.mjs/);
assert.match(
  reusable,
  /WORKFLOW_SHA="\$\{WORKFLOW_SHA\}"[\s\S]*node --input-type=module/,
  "the fixed producer builder must receive the trusted reusable workflow SHA explicitly",
);
assert.doesNotMatch(
  reusable,
  /exporterModuleSha256:/,
  "the exported producer object must contain only the five coordinated workflow identity fields",
);
assert.match(
  reusable,
  /Object\.keys\(producer \?\? \{\}\)\.sort\(\)[\s\S]*\["environment", "repository", "workflow", "workflowFileSha256", "workflowSha"\]/,
  "local verification must reject producer metadata fields outside the exact five-field contract",
);

assert.match(reusable, /gate6-envelope-signer\.yml/);
assert.match(reusable, /SPX_TRUSTED_GATE6_ENVELOPE_SIGNER_SHA/);
assert.match(reusable, /gh attestation verify[\s\S]*--signer-workflow[\s\S]*--signer-digest/);
assert.match(reusable, /gate6-envelope\.json/);
assert.match(reusable, /release-manifest\.json/);
assert.match(reusable, /stage-accept-db-transition/);
assert.match(reusable, /stage-accept-pre-close/);

for (const fixedPath of [
  "/var/lib/spx-gate6/semantic-receipts/stage-accept-db-transition.json",
  "/var/lib/spx-gate6/semantic-receipts/stage-accept-pre-close.json",
  "/var/lib/spx-gate6/artifacts/gate6-envelope.json",
  "/var/lib/spx-production-mutation/lock.json",
  "/var/lib/spx-production-rollout/export/accepted",
  "/var/lib/spx-production-rollout/accepted-evidence-producer-context.json",
]) {
  assert.match(reusable, new RegExp(fixedPath.replaceAll("/", "\\/")));
}
assert.match(reusable, /--phase=db-transition/);
assert.match(reusable, /--phase=pre-close/);
assert.doesNotMatch(
  reusable,
  /gate6-accepted-evidence-export\.mjs[^\n]*(?:--root|--path|--gate6-id|--scope|--action-id|--candidate)/,
);
assert.match(reusable, /accepted-db-transition-evidence\.json/);
assert.match(reusable, /accepted-pre-close-evidence\.json/);
assert.match(reusable, /test "\$\{#exported_files\[@\]\}" -eq 1/);
assert.match(
  reusable,
  /mapfile -t prior_exports[\s\S]*test "\$\{#prior_exports\[@\]\}" -le 1[\s\S]*"\$\{prior_exports\[0\]\}" = "\$\{EXPECTED_FILENAME\}"/,
  "a retry may reconcile the same fixed phase export but no other stale file",
);
assert.match(
  reusable,
  /subject-path:\s*accepted-output\/\$\{\{\s*steps\.phase\.outputs\.filename\s*\}\}/,
);
assert.match(reusable, /retention-days:\s*7/);
assert.ok(
  reusable.indexOf("Upload the exact accepted phase artifact") <
    reusable.indexOf("Remove only the exported phase file after successful upload"),
  "fixed export cleanup must happen only after a successful attestation and upload",
);

assert.doesNotMatch(reusable, /verified\/operator|\/root\/spx-releases|gate6-runtime-control\.mjs/);
assert.doesNotMatch(
  reusable,
  /--action=(?:release|abort|seal-close)|release-host-lock|finalize-slot/,
);
assert.doesNotMatch(reusable, /secrets:\s*inherit/);

console.log("Gate 6 accepted evidence workflow tests passed");
