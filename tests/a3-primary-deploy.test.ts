import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "python" : "python3";
const result = spawnSync(command, ["tests/a3-primary-deploy.test.py"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

process.stdout.write(result.stdout);
