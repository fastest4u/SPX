import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "cmd.exe" : "npx";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "npx tsx src/app.ts"]
  : ["tsx", "src/app.ts"];

const child = spawn(command, args, {
  env: {
    ...process.env,
    HTTP_ENABLED: "true",
    NODE_ENV: "development",
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
