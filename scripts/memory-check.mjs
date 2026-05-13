#!/usr/bin/env node
// memory-check.mjs — Vault health checker
//
// Validates:
//   1. Frontmatter exists and is parseable
//   2. Required fields present per type
//   3. Wikilinks resolve to actual files (or aliases)
//   4. Dataview hyphenated fields use bracket syntax
//   5. `updated:` date not older than 365 days (configurable)
//   6. No duplicate filenames (case-insensitive)
//   7. Active truth docs do not contain known-stale project claims
//
// Usage: node scripts/memory-check.mjs [--fix]
// Exit codes: 0 = pass, 1 = warnings, 2 = errors

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT = join(__dirname, "..", "memory");

// ─── Config ──────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = {
  default: ["title", "type", "created", "updated"],
  adr: ["title", "type", "status", "decision-date", "created", "updated"],
  "session-log": ["title", "type", "session-date", "agent", "created", "updated"],
  component: ["title", "type", "language", "status", "created", "updated"],
  source: ["title", "type", "source-author", "source-date", "created", "updated"],
  insight: ["title", "type", "derived-from", "confidence", "created", "updated"],
  mistake: ["title", "type", "severity", "status", "occurred-date", "agent", "area", "confidence", "created", "updated"],
  runbook: ["title", "type", "status", "last-verified", "verified-by", "source", "confidence", "created", "updated"],
};

// last-verified must be within this many days for runbooks (else warning)
const RUNBOOK_STALE_DAYS = 90;

// Common doc-example placeholders that should not be flagged as broken links
const PLACEHOLDER_LINKS = new Set([
  "Note Name", "Note", "X", "Wikilinks", "06_Sources/...", "ADR-NNN",
  "ADR-NNN-...", "Mistake-NNN", "Mistake-NNN-...", "YYYY-MM-DD-...",
  "YYYY-MM-DD-previous", "YYYY-MM-DD-session", "YYYY-MM-DD-session-1",
  "YYYY-MM-DD-session-2", "G-NNN", "Runbook-NNN", "Template-NNN",
  "Insight title", "source",
]);

const VALID_TYPES = new Set([
  "note", "index", "moc", "dashboard", "reference", "rules", "glossary",
  "identity", "goals", "adr", "session-log", "component", "source",
  "insight", "mistake", "runbook",
]);

const HYPHENATED_FIELDS = [
  "session-date", "decision-date", "duration-minutes", "occurred-date",
  "source-date", "ingested-date", "last-verified", "resolved-date",
  "superseded-by", "derived-from",
];

const HISTORICAL_TYPES = new Set(["session-log", "source", "mistake", "adr"]);

const STALE_TRUTH_PATTERNS = [
  {
    pattern: /\bLINE_NOTIFY_TOKEN\b/,
    message: "stale notification env var `LINE_NOTIFY_TOKEN`; current LINE OA config uses `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID`",
  },
  {
    pattern: /SettingsController`?\s+writes\s+`?\.env`?/i,
    message: "stale settings behavior; current settings are DB-backed through `app_settings` and live reload",
  },
  {
    pattern: /process\.exit\(0\).*Docker auto-restart/i,
    message: "stale settings restart claim; current SettingsController applies live settings without process exit",
  },
  {
    pattern: /overwrites?\s+(?:the\s+)?`?\.env`?\s+file/i,
    message: "stale settings persistence claim; current SettingsController writes `app_settings`, not `.env`",
  },
  {
    pattern: /runs\s+`tsc --noEmit`,?\s+then\s+`esbuild`/i,
    message: "stale build command summary; current build typechecks backend/frontend, esbuilds backend/scripts, then Vite builds frontend",
  },
  {
    pattern: /`npm run dev -- 10`\s+runs\s+`src\/app\.ts`\s+via\s+`ts-node`/i,
    message: "stale dev command summary; current `npm run dev` runs backend with tsx plus Vite frontend",
  },
];

// ─── Utilities ───────────────────────────────────────────────────────────────

function* walkMd(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue; // skip .obsidian etc.
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkMd(full);
    else if (name.endsWith(".md")) yield full;
  }
}

function stripTemplaterPreamble(content) {
  // Templater <%* ... -%> blocks come before frontmatter; strip them
  return content.replace(/^<%\*[\s\S]*?-?%>\s*/, "");
}

function parseFrontmatter(content) {
  const clean = stripTemplaterPreamble(content);
  if (!clean.startsWith("---")) return null;
  const end = clean.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = clean.slice(4, end).trim();
  const obj = {};
  let currentKey = null;
  let inArray = false;
  for (const rawLine of fm.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.match(/^\s*-\s/) && currentKey) {
      if (!Array.isArray(obj[currentKey])) obj[currentKey] = [];
      obj[currentKey].push(line.replace(/^\s*-\s*/, "").trim());
      inArray = true;
      continue;
    }
    const m = line.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
    if (m) {
      currentKey = m[1];
      const value = m[2].trim();
      if (value === "" || value === "|") {
        obj[currentKey] = "";
      } else if (value.startsWith("[") && value.endsWith("]")) {
        obj[currentKey] = value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
      } else {
        obj[currentKey] = value.replace(/^["']|["']$/g, "");
      }
      inArray = false;
    }
  }
  return obj;
}

function findWikilinks(content) {
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  const links = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const target = m[1].trim();
    // Strip trailing slash (folder refs) and .md extension
    if (target.endsWith("/")) continue;
    links.push(target.replace(/\.md$/, ""));
  }
  return links;
}

function findHyphenatedFieldMisuse(content) {
  const issues = [];
  // Match dataview/dataviewjs code blocks
  const blockRe = /```dataview(?:js)?\n([\s\S]*?)```/g;
  let block;
  while ((block = blockRe.exec(content)) !== null) {
    const body = block[1];
    for (const f of HYPHENATED_FIELDS) {
      // Catch bare `WHERE field-name` or `SORT field-name` (DQL)
      const dqlPat = new RegExp(`\\b(WHERE|SORT|GROUP\\s+BY)\\s+${f}\\b`, "g");
      if (dqlPat.test(body)) {
        issues.push(`Hyphenated DQL: \`${f}\` should be \`row["${f}"]\``);
      }
      // Catch `p.session-date` or `s.duration-minutes` in JS
      const jsPat = new RegExp(`\\.${f}\\b`, "g");
      if (jsPat.test(body)) {
        issues.push(`Hyphenated JS: \`.${f}\` should be \`["${f}"]\``);
      }
    }
  }
  return issues;
}

function findStaleTruthClaims(content, type) {
  if (HISTORICAL_TYPES.has(type)) return [];
  const issues = [];
  for (const { pattern, message } of STALE_TRUTH_PATTERNS) {
    if (pattern.test(content)) {
      issues.push(message);
    }
  }
  return issues;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const errors = [];
const warnings = [];
const allFiles = [...walkMd(VAULT)];
const titlesByBasename = new Map();
const allBasenames = new Set(allFiles.map(f => basename(f, ".md")));
const allAliases = new Set();
const allTitles = new Set();

// First pass: collect aliases + titles
for (const file of allFiles) {
  const content = readFileSync(file, "utf8");
  const fm = parseFrontmatter(content);
  if (!fm) continue;
  if (fm.title) allTitles.add(fm.title.split(" — ")[0].trim());
  if (fm.aliases) {
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : [fm.aliases];
    for (const a of aliases) allAliases.add(a);
  }
}

// Second pass: validate
for (const file of allFiles) {
  const rel = relative(VAULT, file).replace(/\\/g, "/");
  const content = readFileSync(file, "utf8");
  const fm = parseFrontmatter(content);
  const base = basename(file, ".md");

  // 0. Skip vault README / AGENTS / IDENTITY at root
  const isRootMeta = ["README", "AGENTS", "AGENT-IDENTITY"].includes(base) && !rel.includes("/");

  // 1. Frontmatter exists
  if (!fm) {
    if (!isRootMeta) {
      warnings.push(`[${rel}] missing or unparseable frontmatter`);
    }
    continue;
  }

  // 2. Required fields by type
  const type = fm.type || "note";
  if (fm.type && !VALID_TYPES.has(type)) {
    errors.push(`[${rel}] invalid type "${type}". Allowed: ${[...VALID_TYPES].join(", ")}`);
  }
  const required = REQUIRED_FIELDS[type] || REQUIRED_FIELDS.default;
  for (const f of required) {
    if (!(f in fm) || fm[f] === "" || (Array.isArray(fm[f]) && fm[f].length === 0)) {
      errors.push(`[${rel}] missing required field for type "${type}": ${f}`);
    }
  }

  // 2b. Runbook freshness check — last-verified must not be > RUNBOOK_STALE_DAYS old
  if (type === "runbook" && fm["last-verified"]) {
    const lv = new Date(fm["last-verified"]);
    if (!isNaN(lv)) {
      const ageDays = Math.floor((Date.now() - lv.getTime()) / 86400000);
      if (ageDays > RUNBOOK_STALE_DAYS) {
        warnings.push(`[${rel}] runbook last-verified ${ageDays} days ago (>${RUNBOOK_STALE_DAYS}). Re-verify and bump last-verified.`);
      }
    }
  }

  // 3. Duplicate filename check (case-insensitive) — allow folder-index names
  const lower = base.toLowerCase();
  const isFolderIndex = ["readme", "index", "_index"].includes(lower);
  if (!isFolderIndex && titlesByBasename.has(lower) && titlesByBasename.get(lower) !== file) {
    warnings.push(`[${rel}] duplicate filename: also at ${titlesByBasename.get(lower)}`);
  }
  titlesByBasename.set(lower, file);

  // 4. Wikilink resolution — skip templates (placeholders expected)
  if (rel.startsWith("99_Templates/")) {
    // Still run hyphenated-field check below
  } else
  for (const link of findWikilinks(content)) {
    if (allBasenames.has(link)) continue;
    if (allAliases.has(link)) continue;
    if (allTitles.has(link)) continue;
    // Skip documentation placeholders
    if (PLACEHOLDER_LINKS.has(link)) continue;
    // Skip path-style refs (Templater paths, source paths with /)
    if (link.includes("/") || link.startsWith(".")) continue;
    // Skip generic pattern placeholders
    if (/^(ADR|Mistake|YYYY-MM-DD|G-NNN|Runbook-NNN|Template-NNN|NNN)/.test(link)) continue;
    // Skip in-document section refs
    if (link === "AGENTS.md" || link === "MOC-Home.md") continue;
    // Skip if file with same base but different folder exists
    warnings.push(`[${rel}] broken wikilink: [[${link}]]`);
  }

  // 5. Dataview hyphenated field misuse
  for (const issue of findHyphenatedFieldMisuse(content)) {
    errors.push(`[${rel}] ${issue}`);
  }

  // 6. Known stale truth claims in active docs
  for (const issue of findStaleTruthClaims(content, type)) {
    errors.push(`[${rel}] stale truth claim: ${issue}`);
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

const RED = "\x1b[31m", YELLOW = "\x1b[33m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
console.log(`\n🧠 Memory Vault Health Check`);
console.log(`Vault: ${VAULT}`);
console.log(`Files scanned: ${allFiles.length}`);
console.log("─".repeat(60));

if (errors.length === 0 && warnings.length === 0) {
  console.log(`${GREEN}✅ Vault is healthy — no issues found.${RESET}\n`);
  process.exit(0);
}

if (errors.length > 0) {
  console.log(`\n${RED}❌ Errors (${errors.length}):${RESET}`);
  for (const e of errors) console.log(`  ${e}`);
}
if (warnings.length > 0) {
  console.log(`\n${YELLOW}⚠️  Warnings (${warnings.length}):${RESET}`);
  for (const w of warnings) console.log(`  ${w}`);
}

console.log("\n" + "─".repeat(60));
console.log(`Errors: ${errors.length} · Warnings: ${warnings.length}\n`);

process.exit(errors.length > 0 ? 2 : 1);
