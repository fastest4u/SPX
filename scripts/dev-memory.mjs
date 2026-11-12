import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "cmd.exe" : "npm";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm run dev"]
  : ["run", "dev"];

const child = spawn(command, args, {
  env: {
    ...process.env,
    DB_MODE: "memory",
    SPX_TEST_SKIP_ENV_FILE: "1",
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
