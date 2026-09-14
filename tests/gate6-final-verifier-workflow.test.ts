import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readWorkflow = (name: string): string => readFileSync(`.github/workflows/${name}`, "utf8");

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
      `${workflowName} must validate untrusted inputs through env`,
    );
  }
}

const dispatcher = readWorkflow("gate6-final-verifier.yml");
const exporter = readWorkflow("gate6-final-verifier-exporter.yml");
const runtime = readWorkflow("gate6-runtime.yml");
const executor = readWorkflow("gate6-runtime-executor.yml");

assert.match(dispatcher, /on:\s*\n\s*workflow_dispatch:/);
assert.match(dispatcher, /^permissions:\s*\{\}\s*$/m);
assert.doesNotMatch(dispatcher, /\bruns-on:|^\s+steps:/m);
assert.doesNotMatch(dispatcher, /\benvironment:|secrets:\s*inherit|\$\{\{\s*secrets\./);
for (const input of ["candidate_sha", "approval_artifact_id", "approval_run_id"]) {
  assert.match(
    dispatcher,
    new RegExp(`${input}:[\\s\\S]{0,160}required:\\s*true[\\s\\S]{0,80}type:\\s*string`),
  );
}
assert.match(
  dispatcher,
  /uses:\s*fastest4u\/SPX\/\.github\/workflows\/gate6-final-verifier-exporter\.yml@0{40}/,
);
assert.match(dispatcher, /BOOTSTRAP-DENY/);
for (const permission of [
  "actions: read",
  "attestations: write",
  "contents: read",
  "id-token: write",
]) {
  assert.match(dispatcher, new RegExp(permission));
}

assert.match(exporter, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(exporter, /workflow_dispatch:/);
assert.match(exporter, /^permissions:\s*\{\}\s*$/m);
assert.match(exporter, /environment:\s*production/);
assert.match(
  exporter,
  /concurrency:[\s\S]*group:\s*spx-production-mutation[\s\S]*cancel-in-progress:\s*false/,
);
assert.doesNotMatch(exporter, /^\s+queue:/m);
for (const input of ["candidate_sha", "approval_artifact_id", "approval_run_id"]) {
  assert.match(
    exporter,
    new RegExp(`${input}:[\\s\\S]{0,160}required:\\s*true[\\s\\S]{0,80}type:\\s*string`),
  );
}
assert.match(exporter, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(exporter, /SPX_TRUSTED_GATE6_FINAL_VERIFIER_EXPORTER_SHA/);
assert.match(exporter, /SPX_GATE6_FINAL_VERIFIER_EXPORTER_WORKFLOW_SHA256/);
assert.match(exporter, /SPX_GATE6_FINAL_VERIFIER_EXPORTER_MODULE_SHA256/);
assert.match(exporter, /ref:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(exporter, /artifact-ids:\s*\$\{\{\s*inputs\.approval_artifact_id\s*\}\}/);
assert.match(exporter, /run-id:\s*\$\{\{\s*inputs\.approval_run_id\s*\}\}/);
assert.match(exporter, /gate6-envelope-signer\.yml/);
assert.match(exporter, /--signer-workflow\s+/);
assert.match(exporter, /--signer-digest\s+/);
assert.match(exporter, /--deny-self-hosted-runners/);
assert.match(
  exporter,
  /sparse-checkout:[\s\S]*?scripts\/lib\/github-attestation-run\.mjs/,
  "the exporter must check out the exact attestation run-binding module it invokes",
);
assert.match(
  exporter,
  /fetch_artifact_metadata\(\)\s*\{/,
  "the exporter must derive artifact metadata from the authoritative GitHub API",
);
assert.match(
  exporter,
  /actions\/runs\/\$\{authoritative_run_id\}/,
  "the authoritative run_attempt must come from the exact run, not caller input",
);
assert.match(
  exporter,
  /verify_attested_file\(\)\s*\{/,
  "every approval file must pass through the shared exact run/attempt binding verifier",
);
assert.match(
  exporter,
  /verify_attested_file\s+"\$\{file\}"\s+"\$\{APPROVAL_ARTIFACT_ID\}"\s+"\$\{APPROVAL_RUN_ID\}"/,
  "the approval artifact and run IDs must reach verify_attested_file",
);
assert.match(
  exporter,
  /node\s+trusted\/scripts\/lib\/github-attestation-run\.mjs\s*\\/,
  "the exporter must invoke the attestation run-binding module from the trusted checkout",
);
assert.match(exporter, /\/var\/lib\/spx-production-rollout\/evidence\/final-verifier\.json/);
assert.match(exporter, /\/var\/lib\/spx-production-mutation\/lock\.json/);
assert.match(
  exporter,
  /\/usr\/bin\/node\s+"\$\{TRUSTED_ROOT\}\/scripts\/gate6-final-verifier-export\.mjs"\s*$/m,
  "the protected final exporter must accept zero arguments",
);
assert.doesNotMatch(exporter, /releaseRun\s*\(|completeRelease\s*\(|--action=release/);
assert.match(exporter, /subject-path:\s*final-verifier-output\/final-verifier\.json/);
assert.match(
  exporter,
  /name:\s*spx-gate6-final-verifier-\$\{\{\s*inputs\.candidate_sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/,
);
assert.match(exporter, /path:\s*final-verifier-output\/final-verifier\.json/);
assert.doesNotMatch(
  exporter.slice(exporter.indexOf("Upload the exact final verifier artifact")),
  /semantic-receipts|gate6-actions|raw|ledger\.json/,
);
for (const action of [
  "actions/checkout",
  "actions/download-artifact",
  "actions/attest-build-provenance",
  "actions/upload-artifact",
]) {
  assert.match(exporter, new RegExp(`${action.replace("/", "\\/")}@[0-9a-f]{40}`));
}
assertNoInputExpressionInRunBlocks(exporter, "gate6-final-verifier-exporter.yml");

for (const source of [runtime, executor]) {
  for (const input of ["final_verifier_artifact_id", "final_verifier_run_id"]) {
    assert.match(source, new RegExp(`${input}:`));
  }
}
assert.match(
  executor,
  /OPERATION[\s\S]*release[\s\S]*FINAL_VERIFIER_ARTIFACT_ID[\s\S]*FINAL_VERIFIER_RUN_ID/,
);
assert.match(executor, /artifact-ids:\s*\$\{\{\s*inputs\.final_verifier_artifact_id\s*\}\}/);
assert.match(executor, /run-id:\s*\$\{\{\s*inputs\.final_verifier_run_id\s*\}\}/);
assert.match(executor, /deploy\/protected-evidence-producers\.json/);
assert.match(executor, /scripts\/lib\/protected-evidence-producers\.mjs/);
assert.match(executor, /producerFor\("final-verifier"\)/);
assert.match(
  executor,
  /assertProtectedEvidenceFileSet\(\s*"final-verifier",\s*"verified-input\/final-verifier"/,
);
assert.match(
  executor,
  /verify_attested_file[\s\\]+verified-input\/final-verifier\/final-verifier\.json[\s\\]+"\$\{FINAL_VERIFIER_ARTIFACT_ID\}"[\s\\]+"\$\{FINAL_VERIFIER_RUN_ID\}"[\s\\]+"\$\{FINAL_VERIFIER_WORKFLOW\}"[\s\\]+"\$\{FINAL_VERIFIER_SIGNER_SHA\}"/,
  "the final-verifier artifact, run, and independently pinned signer variables must reach verify_attested_file",
);
assert.match(executor, /producer\.bootstrapDenied\s*!==\s*false/);
assert.doesNotMatch(
  executor,
  /signer_workflow="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/gate6-runtime-executor\.yml"/,
);
assert.match(executor, /test "\$\{#delivery_files\[@\]\}" -eq 2/);
assert.match(executor, /gate6-release\.json/);
assert.match(executor, /final-verifier\.json/);
assert.match(
  executor,
  /--final-verifier="\$\{final_verifier\}"[\s\S]*rm -f -- "\$\{final_verifier\}"/,
  "the fixed final verifier must remain until release succeeds and then be removed for the next run",
);
assert.match(
  executor,
  /tar[\s\S]*-cf gate6-delivery\.tar -C delivery-input \./,
  "release delivery must be built from the exact bounded input directory",
);

console.log("Gate 6 final verifier workflow tests passed");
