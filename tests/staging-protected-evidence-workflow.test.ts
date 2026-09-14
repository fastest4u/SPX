import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dispatcher = readFileSync(".github/workflows/staging-protected-evidence.yml", "utf8");
const trusted = readFileSync(".github/workflows/trusted-staging-protected-evidence.yml", "utf8");
const inputs = [
  "candidate_sha",
  "release_artifact_id",
  "release_run_id",
  "staging_target_artifact_id",
  "staging_target_run_id",
  "staging_approval_artifact_id",
  "staging_approval_run_id",
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
assert.doesNotMatch(dispatcher, /\$\{\{\s*secrets\.|\bssh\b|\bscp\b|secrets:\s*inherit/);
assert.match(dispatcher, /BOOTSTRAP-DENY/);
assert.match(
  dispatcher,
  /uses:\s*fastest4u\/SPX\/\.github\/workflows\/trusted-staging-protected-evidence\.yml@0000000000000000000000000000000000000000/,
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
assert.match(trusted, /environment:\s*staging/);
assert.match(trusted, /group:\s*spx-staging-a3/);
assert.doesNotMatch(trusted, /^\s+queue:/m);
assert.match(trusted, /cancel-in-progress:\s*false/);
assert.match(trusted, /ref:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trusted, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trusted, /SPX_TRUSTED_STAGING_PROTECTED_EVIDENCE_WORKFLOW_SHA/);
assert.doesNotMatch(trusted, /secrets:\s*inherit|ssh-keyscan/);
pinnedActions(trusted);

for (const block of runBlocks(trusted)) {
  assert.doesNotMatch(block, /\$\{\{\s*inputs\./, "shell blocks must receive inputs through env");
}
assert.doesNotMatch(trusted, /ref:\s*\$\{\{\s*inputs\.candidate_sha/);
assert.doesNotMatch(trusted, /(?:node|bash|sh)\s+[^\n]*inert-inputs\//);
assert.match(trusted, /gh attestation verify "\$\{path\}" -R fastest4u\/SPX/);
assert.match(
  trusted,
  /TARGET_WORKFLOW_SHA:\s*\$\{\{\s*vars\.SPX_TRUSTED_DESCRIPTOR_SIGNER_SHA\s*\}\}/,
);
assert.doesNotMatch(trusted, /SPX_TRUSTED_TARGET_WORKFLOW_SHA/);
for (const workflow of [
  "trusted-release-artifact.yml",
  "deployment-target-descriptor-signer.yml",
  "staging-rollout-signer.yml",
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
  "/var/lib/spx-staging-rollout/verified-release-binding.json",
  "/var/lib/spx-staging-rollout/actions.jsonl",
  "/var/lib/spx-staging-rollout/evidence/gates/",
  "/var/lib/spx-staging-rollout/task9-evidence/",
  "/var/lib/spx-staging-rollout/evidence/worker-staging/",
  "/var/lib/spx-staging-rollout/evidence/phase3-staging/",
  "/var/lib/spx-staging-rollout/evidence/phase4-staging/",
  "/var/lib/spx-staging-rollout/evidence/phase4-n-minus-one-staging/",
]) {
  assert.match(
    `${trusted}\n${readFileSync("scripts/staging-protected-evidence-export.mjs", "utf8")}`,
    new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}
assert.match(trusted, /protected-evidence-producer-context\.json/);
assert.match(trusted, /trusted\/\.github\/workflows\/trusted-staging-protected-evidence\.yml/);
assert.match(trusted, /workflow_file_sha256/);
assert.match(
  trusted,
  /\/usr\/bin\/node "\$\{ROOT\}\/scripts\/staging-protected-evidence-export\.mjs"/,
);
assert.match(trusted, /subject-path:\s*protected-output\/staging-protected-evidence\.json/);
assert.match(trusted, /path:\s*protected-output\/staging-protected-evidence\.json/);
assert.match(
  trusted,
  /name:\s*spx-staging-protected-evidence-\$\{\{ inputs\.candidate_sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
);

console.log("staging protected evidence workflow tests passed");
