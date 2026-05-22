import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "cmd.exe" : "npx";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "npx vite"]
  : ["vite"];

const child = spawn(command, args, {
  env: {
    ...process.env,
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
