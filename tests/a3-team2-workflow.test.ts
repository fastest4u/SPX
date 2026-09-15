import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const trustedPath = ".github/workflows/trusted-team2-deploy.yml";
const trusted = readFileSync(trustedPath, "utf8");
const dispatcher = readFileSync(".github/workflows/a3-deploy.yml", "utf8");

assert.match(trusted, /workflow_call:/);
assert.match(trusted, /environment:\s+production/);
assert.match(trusted, /attestations:\s+write/);
assert.match(trusted, /id-token:\s+write/);
assert.match(trusted, /SPX_TRUSTED_TEAM2_DEPLOY_WORKFLOW_SHA/);
assert.match(trusted, /\$\{\{ job\.workflow_sha \}\}/);
assert.match(trusted, /release_artifact_id/);
assert.match(trusted, /target_descriptor_artifact_id/);
assert.match(trusted, /gh attestation verify[\s\S]*trusted-release-artifact\.yml/);
for (const trustedReleaseSubject of [
  "bootstrap/scripts/build-operator-bundle.mjs",
  "bootstrap/scripts/deployment-target-descriptor.mjs",
  "bootstrap/scripts/lib/safe-file.mjs",
  "bootstrap/src/services/deployment-target-descriptor.ts",
  "bootstrap/src/services/release-manifest.ts",
  "build-manifest.json",
  "operator-bundle.index.json",
  "operator-bundle.tar",
  "release-artifact.index.json",
  "release-manifest.json",
  "spx-dist.tar",
  "spx-image.tar",
]) {
  assert.ok(
    trusted.includes(`verified/release/${trustedReleaseSubject}`),
    `trusted workflow must verify ${trustedReleaseSubject}`,
  );
}
assert.match(trusted, /--deny-self-hosted-runners/);
assert.match(trusted, /deployment-target-descriptor\.mjs verify/);
assert.match(trusted, /SPX_DESCRIPTOR_TEAM2_TARGET_FACTS_SHA256/);
assert.match(trusted, /descriptor\.deploymentUnit !== "team2"/);
assert.match(trusted, /test "\$\{SPX_TEAM2_HOST\}" = 147\.50\.240\.44/);
assert.match(trusted, /sha256sum ~\/\.ssh\/known_hosts/);
assert.match(trusted, /tarfile\.open\(sys\.argv\[1\], "r:"\)/);
assert.match(trusted, /unsafe TEAM 2 payload member/);
assert.match(trusted, /a3-team2-deploy\.py" install/);
assert.match(trusted, /--managed-root='\/opt\/spx-production-team2'/);
assert.match(trusted, /--state-root='\/var\/lib\/spx-production-team2-rollout'/);
assert.match(trusted, /--environment-file='\/etc\/spx-production\/runtime\.env'/);
assert.match(trusted, /actions\/attest-build-provenance@[0-9a-f]{40}/);
assert.match(trusted, /actions\/upload-artifact@[0-9a-f]{40}/);
assert.doesNotMatch(trusted, /ubuntu-latest|@[A-Za-z][A-Za-z0-9._-]*$/m);
for (const match of trusted.matchAll(/uses:\s+([^\s]+)/g)) {
  assert.match(match[1], /@[0-9a-f]{40}$/, `action must be SHA-pinned: ${match[1]}`);
}

assert.match(dispatcher, /team2_target_descriptor_artifact_id:/);
assert.match(dispatcher, /deploy-primary:/);
assert.match(dispatcher, /deploy-team2:[\s\S]*needs:\s+deploy-primary/);
assert.match(dispatcher, /deploy-team2:[\s\S]*attestations:\s+write/);
assert.match(dispatcher, /deploy-team2:[\s\S]*id-token:\s+write/);
assert.match(dispatcher, /if:\s+inputs\.target == 'production'/);
assert.match(
  dispatcher,
  /uses:\s*fastest4u\/SPX\/\.github\/workflows\/trusted-team2-deploy\.yml@[0-9a-f]{40}/,
);
assert.match(dispatcher, /target_descriptor_artifact_id:\s+\$\{\{ inputs\.team2_target_descriptor_artifact_id \}\}/);

console.log("A3 TEAM 2 protected workflow is host-scoped and ordered after primary");
