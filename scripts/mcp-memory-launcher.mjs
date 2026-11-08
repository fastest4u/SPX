#!/usr/bin/env node
// mcp-memory-launcher.mjs — auto-detect Project Memory V2 (or V1 fallback) bindings and start the MCP server.
//
// Why this exists:
//   Project Memory V2 (`dist/v2.js`) requires four explicit canonical environment bindings:
//     - MEMORY_PROJECT_ROOT
//     - MEMORY_V2_VAULT_PATH
//     - MEMORY_V1_ARCHIVE_PATH
//     - MEMORY_V2_RELEASE_ID
//
//   When a project has been initialized for V2, `<projectRoot>/memory-v2/.memory-mcp/fresh-start-init.json`
//   contains the exact canonical paths and releaseId. This launcher walks up from process.cwd()
//   (or workspace env variables) to locate `memory-v2/.memory-mcp/fresh-start-init.json`, populates
//   all 4 V2 env vars, and spawns `dist/v2.js` with stdio passthrough.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const V2_INIT_MARKER = join("memory-v2", ".memory-mcp", "fresh-start-init.json");
const V1_VAULT_MARKER = join("memory", "AGENTS.md");

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

function findRootByMarker(marker) {
  for (const key of WORKSPACE_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    const parts = raw
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      try {
        if (existsSync(join(p, marker))) return p;
      } catch {
        // ignore unreadable candidate
      }
    }
  }
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(dir, marker))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function logErr(...args) {
  console.error("[mcp-memory-launcher]", ...args);
}

const startDir = process.cwd();
const explicit = process.env.MEMORY_PROJECT_ROOT;

let projectRoot =
  explicit && explicit !== "dynamic"
    ? explicit
    : findRootByMarker(V2_INIT_MARKER) || findRootByMarker(V1_VAULT_MARKER) || startDir;

const childEnv = { ...process.env, MEMORY_PROJECT_ROOT: projectRoot };
const v2InitPath = join(projectRoot, V2_INIT_MARKER);
if (existsSync(v2InitPath)) {
  try {
    const initJson = JSON.parse(readFileSync(v2InitPath, "utf8"));
    if (initJson?.paths?.projectRoot) childEnv.MEMORY_PROJECT_ROOT = initJson.paths.projectRoot;
    if (initJson?.paths?.v2VaultRoot && !childEnv.MEMORY_V2_VAULT_PATH) {
      childEnv.MEMORY_V2_VAULT_PATH = initJson.paths.v2VaultRoot;
    }
    if (initJson?.paths?.v1ArchiveRoot && !childEnv.MEMORY_V1_ARCHIVE_PATH) {
      childEnv.MEMORY_V1_ARCHIVE_PATH = initJson.paths.v1ArchiveRoot;
    }
    if (initJson?.release?.releaseId && !childEnv.MEMORY_V2_RELEASE_ID) {
      childEnv.MEMORY_V2_RELEASE_ID = initJson.release.releaseId;
    }
    logErr(`loaded V2 bindings from ${v2InitPath} (releaseId=${childEnv.MEMORY_V2_RELEASE_ID})`);
  } catch (err) {
    logErr(`failed to parse ${v2InitPath}: ${err.message}`);
  }
}

const realServer =
  process.argv[2] || "C:\\Users\\Server\\Desktop\\Awakened-AI-System\\dist\\v2.js";

const serverPath = isAbsolute(realServer) ? realServer : resolve(startDir, realServer);
if (!existsSync(serverPath)) {
  logErr(`server not found: ${serverPath}`);
  process.exit(2);
}

const extraArgs = process.argv.slice(3);
const child = spawn(process.execPath, [serverPath, ...extraArgs], {
  env: childEnv,
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

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
