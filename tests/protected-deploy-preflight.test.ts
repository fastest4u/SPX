import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(".github/workflows/trusted-deploy.yml", "utf8");
const preflight = source.match(/node --input-type=module -e '\s*(import \{ readFileSync \} from "node:fs";\s*const previous=[\s\S]*?const classification=[\s\S]*?)\n\s*' "\$\{CURRENT_PARENT\}\/release-manifest.json"/);
assert.ok(preflight, "production upgrade preflight must be executable");
const code = preflight[1].replace('import { readFileSync } from "node:fs";', "");
const directory = mkdtempSync(join(tmpdir(), "spx-protected-upgrade-"));
const services = ["web-api", "notification-service", "line-service", "ocr-service", "worker-ifn-split", "worker-ptwl-split"];

function check(previous: unknown, candidate: unknown, context: unknown = { topology: "split" }, approvedServices = services) {
  const values = [previous, candidate, { migrations: {} }, context, { services: approvedServices }];
  const files = values.map((value, index) => {
    const path = join(directory, `${index}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  });
  runInNewContext(code, { readFileSync, process: { argv: ["node", ...files] } }, { timeout: 1000 });
}

try {
  const failures: string[] = [];
  for (const [name, previous, candidate, context, approvedServices] of [
    ["rollback cannot read expanded schema", { schema: { min: 33, max: 36 } }, { schema: { min: 33, max: 37 } }],
    ["previous schema range is inverted", { schema: { min: 38, max: 36 } }, { schema: { min: 33, max: 36 } }],
    ["candidate schema range is inverted", { schema: { min: 33, max: 36 } }, { schema: { min: 37, max: 36 } }],
    ["legacy baseline requires coordinated adoption", { schema: { min: 33, max: 36 } }, { schema: { min: 33, max: 36 } }, { topology: "legacy" }],
    ["remote worker is not owned by local baseline", { schema: { min: 33, max: 36 } }, { schema: { min: 33, max: 36 } }, { topology: "split" }, services.filter((service) => service !== "worker-ifn-split")],
  ] as Array<[string, unknown, unknown, unknown?, string[]?]>) {
    try {
      assert.throws(() => check(previous, candidate, context, approvedServices), undefined, name);
    } catch {
      failures.push(name);
    }
  }
  assert.doesNotThrow(() => check({ schema: { min: 33, max: 36 } }, { schema: { min: 33, max: 36 } }));

  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  if (process.platform === "win32") assert.ok(existsSync(bash), "Git Bash is required for actual deployment-shell regressions");
  const stopBlock = source.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line.startsWith("candidate_compose stop notifier ")
      || line.startsWith("candidate_compose --profile split up -d web-api ")).join("\n");
  assert.ok(stopBlock);
  const stopped = spawnSync(bash, ["-c", `set -Eeuo pipefail
candidate_compose() { if [ "$1" = stop ]; then printf 'stop-failed\\n'; return 97; fi; printf 'candidate-activated\\n'; }
trap 'printf "rollback-required\\n"' ERR
${stopBlock}`], { encoding: "utf8" });
  assert.ifError(stopped.error);
  if (stopped.status !== 97 || stopped.stdout.includes("candidate-activated") || !stopped.stdout.includes("rollback-required")) {
    failures.push("stop failure must prevent candidate activation and trigger rollback");
  }

  const imageSteps = source.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line.startsWith('docker load --input "${INCOMING}/release/spx-image.tar"')
      || line.startsWith('test "$(docker image inspect --format')
      || line.startsWith('RUNTIME_DEPS_CONTAINER="$(docker create')).join("\n");
  const loaded = spawnSync(bash, ["-c", `set -Eeuo pipefail
INCOMING=/synthetic; IMAGE_TAG=synthetic; IMAGE_ID=synthetic-image; loaded=false
docker() { case "$1" in load) loaded=true ;; image) [ "$loaded" = true ] || return 66; printf '%s' "$IMAGE_ID" ;; create) [ "$loaded" = true ] || return 66; printf 'synthetic-container' ;; *) return 90 ;; esac; }
${imageSteps}
printf 'candidate-created\\n'`], { encoding: "utf8" });
  assert.ifError(loaded.error);
  if (loaded.status !== 0 || !loaded.stdout.includes("candidate-created")) failures.push("fresh image must load before runtime dependency container creation");
  assert.deepEqual(failures, []);
  console.log("Protected deployment preflight: rollback schema, local baseline, stop failure and fresh image ordering pass");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
