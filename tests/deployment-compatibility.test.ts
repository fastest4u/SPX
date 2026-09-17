import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const directory = mkdtempSync(join(tmpdir(), "spx-deployment-contract-"));
const script = resolve("scripts/deployment-compatibility.mjs");
const source = join(directory, "contract.json");
const staged = join(directory, "deployment-contract.json");
const output = join(directory, "github-output");
const legacy = { schemaVersion: 1, mode: "legacy" };
const protectedA3 = { schemaVersion: 1, mode: "protected-a3" };
const repositoryContract = resolve("deploy/runtime-deployment-contract.json");

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.ifError(result.error);
  return result;
}

try {
  for (const contract of [legacy, protectedA3]) {
    writeFileSync(source, JSON.stringify(contract));
    const result = run("stage", source, staged);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(staged, "utf8")), contract);
    writeFileSync(output, "");
    const checked = run("check", staged, "--github-output");
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), {
      deploymentMode: contract.mode, legacyDeployAllowed: contract.mode === "legacy",
    });
    assert.equal(readFileSync(output, "utf8"),
      `legacy_deploy_allowed=${contract.mode === "legacy"}\ndeployment_mode=${contract.mode}\n`);
    const required = run("check", staged, "--require-legacy");
    assert.equal(required.status, contract.mode === "legacy" ? 0 : 1);
    if (contract.mode === "protected-a3") assert.match(required.stderr, /protected A3 installer/);
  }

  for (const content of ["not json", "null", "{}", "[]",
    '{"schemaVersion":true,"mode":"legacy"}',
    '{"schemaVersion":2,"mode":"legacy"}',
    '{"schemaVersion":1,"mode":"unknown"}',
    '{"schemaVersion":1,"mode":"legacy","unexpected":true}']) {
    writeFileSync(source, content);
    writeFileSync(output, "");
    const checked = run("check", source, "--github-output");
    assert.equal(checked.status, 1);
    assert.equal(readFileSync(output, "utf8"), "");
    const previous = readFileSync(staged, "utf8");
    assert.equal(run("stage", source, staged).status, 1);
    assert.equal(readFileSync(staged, "utf8"), previous);
  }
  assert.equal(run("check", join(directory, "missing.json"), "--require-legacy").status, 1);
  assert.equal(run("unknown", source).status, 1);
  assert.equal(run("check", source, "--allow-a3").status, 1);
  const repositoryContractData = JSON.parse(readFileSync(repositoryContract, "utf8")) as { schemaVersion: number; mode: string };
  const repositoryContractCheck = run("check", repositoryContract, `--require-${repositoryContractData.mode}`);
  assert.equal(repositoryContractCheck.status, 0, repositoryContractCheck.stderr);
  writeFileSync(source, JSON.stringify(legacy));
  const rejectedLegacyCandidate = run("check", source, "--require-protected-a3");
  assert.equal(rejectedLegacyCandidate.status, 1);
  assert.match(rejectedLegacyCandidate.stderr, /requires protected A3 runtime/);

  const a3Dockerfile = readFileSync("Dockerfile.a3", "utf8");
  assert.match(a3Dockerfile, /COPY --chown=node:node scripts\/deployment-compatibility\.mjs/);
  assert.match(a3Dockerfile,
    /deployment-compatibility\.mjs check dist\/deployment-contract\.json --require-protected-a3/);
  const releaseWorkflow = readFileSync(".github/workflows/release-artifact.yml", "utf8");
  assert.match(releaseWorkflow,
    /deployment-compatibility\.mjs check dist\/deployment-contract\.json --require-protected-a3/);
  const require = createRequire(import.meta.url);
  const yaml = require("js-yaml") as { load: (text: string) => {
    jobs: Record<string, { if?: string; needs?: string | string[]; environment?: string;
      outputs?: Record<string, string>; steps?: Array<{ id?: string; run?: string }> }>;
  } };
  const workflow = yaml.load(readFileSync(process.argv[2] ?? ".github/workflows/deploy.yml", "utf8"));
  const compatibilityStep = workflow.jobs.build.steps?.find((step) => step.id === "deployment-compatibility");
  assert.ok(compatibilityStep?.run);
  assert.equal(workflow.jobs.build.outputs?.legacy_deploy_allowed,
    "${{ steps.deployment-compatibility.outputs.legacy_deploy_allowed }}");
  const productionJobs = Object.entries(workflow.jobs).filter(([, job]) => job.environment === "production");
  assert.ok(productionJobs.length >= 3);
  for (const mode of ["true", "false", "", undefined]) {
    for (const [name, job] of productionJobs) {
      const dependencies = Array.isArray(job.needs) ? job.needs : [job.needs];
      assert.ok(dependencies.includes("build"), `${name} must consume the checked build`);
      const permitted = runInNewContext(job.if ?? "true", {
        github: { ref: "refs/heads/main" },
        needs: { build: { outputs: { legacy_deploy_allowed: mode } } },
      }, { timeout: 1000 });
      assert.equal(permitted, mode === "true", `${name} deployment decision for ${mode}`);
    }
  }
  console.log("Deployment compatibility: exact contracts, artifact staging and fail-closed legacy selection pass");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
