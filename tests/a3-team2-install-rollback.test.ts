import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("python", ["tests/a3-team2-install-rollback.test.py"], {
  encoding: "utf8",
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});

assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /TEAM 2 failed activation restores legacy and protected managed state/);

console.log("A3 TEAM 2 installer rollback regression passes");
