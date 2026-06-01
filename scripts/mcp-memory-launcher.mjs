#!/usr/bin/env node
// mcp-memory-launcher.mjs — auto-detect MEMORY_PROJECT_ROOT and start the MCP server.
//
// Why this exists:
//   The Awakened-AI-System MCP server reads MEMORY_PROJECT_ROOT from env.
//   Setting it to the literal "dynamic" relies on the server's auto-discovery,
//   which is broken in some Windsurf installs (falls back to ~/memory).
//   Hardcoding an absolute path locks the config to one project.
//
//   This launcher solves both:
//     1. Walks up from process.cwd() looking for `memory/AGENTS.md` (the vault marker).
//     2. Sets MEMORY_PROJECT_ROOT to the discovered `memory/` folder.
//     3. Spawns the real MCP server with stdio passthrough.
//
//   Result: open ANY project that has a `memory/AGENTS.md` file and the launcher
//   resolves to that project's vault automatically. No per-project hardcoded paths.
//
// Usage (workspace `.windsurf/mcp.json`):
//   {
//     "mcpServers": {
//       "project-memory": {
//         "command": "node",
//         "args": [
//           "scripts/mcp-memory-launcher.mjs",
//           "C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js"
//         ]
//       }
//     }
//   }
//
// Usage (`.codex/config.toml`):
//   [mcp_servers.project-memory]
//   command = "node"
//   args = [
//     "scripts/mcp-memory-launcher.mjs",
//     "C:/Users/Server/Desktop/Awakened-AI-System/dist/index.js"
//   ]
//
// Override:
//   If MEMORY_PROJECT_ROOT is already set in env (e.g. workspace override or CI),
//   the launcher honors it without auto-detection.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const VAULT_MARKER = join("memory", "AGENTS.md");

// Env vars that may carry the active workspace path (varies by host/editor).
const WORKSPACE_ENV_KEYS = [
  "WORKSPACE_FOLDER_PATHS",
  "WORKSPACE_FOLDER",
  "WORKSPACE_ROOT",
  "PROJECT_ROOT",
  "VSCODE_WORKSPACE_FOLDER",
  "VSCODE_CWD",
  "WINDSURF_WORKSPACE",
  "WINDSURF_WORKSPACE_FOLDER",
  "CODEIUM_WORKSPACE",
  "PWD",
  "INIT_CWD",
];

// Return the first env-provided path that actually contains a memory/AGENTS.md vault.
function findRootFromEnv() {
  for (const key of WORKSPACE_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    const parts = raw
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      try {
        if (existsSync(join(p, VAULT_MARKER))) return p;
      } catch {
        // ignore unreadable candidate
      }
    }
  }
  return null;
}

function findVaultRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, VAULT_MARKER))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

function logErr(...args) {
  // Use stderr so MCP stdout (JSON-RPC frames) stays clean.
  console.error("[mcp-memory-launcher]", ...args);
}

const startDir = process.cwd();
const explicit = process.env.MEMORY_PROJECT_ROOT;

let projectRoot;
if (explicit && explicit !== "dynamic") {
  projectRoot = explicit;
  logErr(`using explicit MEMORY_PROJECT_ROOT=${projectRoot}`);
} else {
  const envRoot = findRootFromEnv();
  const found = envRoot || findVaultRoot(startDir);
  if (found) {
    projectRoot = found;
    logErr(`auto-detected MEMORY_PROJECT_ROOT=${projectRoot} (cwd=${startDir})`);
  } else {
    projectRoot = startDir;
    logErr(`no memory/AGENTS.md found from cwd=${startDir}; defaulting to ${projectRoot}`);
  }
}

const realServer = process.argv[2];
if (!realServer) {
  logErr("usage: node mcp-memory-launcher.mjs <path-to-mcp-server.js> [extra args...]");
  process.exit(2);
}

const serverPath = isAbsolute(realServer) ? realServer : resolve(startDir, realServer);
if (!existsSync(serverPath)) {
  logErr(`server not found: ${serverPath}`);
  process.exit(2);
}

const extraArgs = process.argv.slice(3);
const child = spawn(process.execPath, [serverPath, ...extraArgs], {
  env: { ...process.env, MEMORY_PROJECT_ROOT: projectRoot },
  stdio: "inherit",
});

child.on("error", (err) => {
  logErr(`failed to spawn server: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

// Forward signals so Windsurf's shutdown propagates to the MCP server.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
