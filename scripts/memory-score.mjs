#!/usr/bin/env node
// memory-score.mjs - deterministic quality summary for the SPX Memory Vault.
//
// This is a dashboard command, not an AI evaluator. It reports measurable
// health signals: source grounding, stale notes, broken links, open mistakes,
// session follow-ups, and multi-AI acceptance status.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const VAULT = join(ROOT, "memory");

const PLACEHOLDER_LINKS = new Set([
  "Note Name", "Note", "X", "Wikilinks", "06_Sources/...", "ADR-NNN",
  "ADR-NNN-...", "Mistake-NNN", "Mistake-NNN-...", "YYYY-MM-DD-...",
  "YYYY-MM-DD-previous", "YYYY-MM-DD-session", "YYYY-MM-DD-session-1",
  "YYYY-MM-DD-session-2", "G-NNN", "Runbook-NNN", "Template-NNN",
  "Insight title", "source",
]);

const SOURCE_CANDIDATE_TYPES = new Set([
  "reference",
  "runbook",
  "component",
]);

function* walkMd(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkMd(full);
    else if (name.endsWith(".md")) yield full;
  }
}

function stripTemplaterPreamble(content) {
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

  for (const rawLine of fm.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.match(/^\s*-\s/) && currentKey) {
      if (!Array.isArray(obj[currentKey])) obj[currentKey] = [];
      obj[currentKey].push(line.replace(/^\s*-\s*/, "").trim());
      continue;
    }

    const m = line.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
    if (!m) continue;
    currentKey = m[1];
    const value = m[2].trim();
    if (value === "" || value === "|") {
      obj[currentKey] = "";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      obj[currentKey] = value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      obj[currentKey] = value.replace(/^["']|["']$/g, "");
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
    if (target.endsWith("/")) continue;
    links.push(target.replace(/\.md$/, ""));
  }
  return links;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageDays(date) {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function listUncheckedTasks(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s+\[\s\]\s+/.test(line));
}

function readAllNotes() {
  const files = [...walkMd(VAULT)];
  return files.map((file) => {
    const content = readFileSync(file, "utf8");
    return {
      file,
      rel: relative(VAULT, file).replace(/\\/g, "/"),
      base: basename(file, ".md"),
      content,
      fm: parseFrontmatter(content),
    };
  });
}

function findBrokenLinks(notes) {
  const basenames = new Set(notes.map((note) => note.base));
  const aliases = new Set();
  const titles = new Set();

  for (const note of notes) {
    const fm = note.fm;
    if (!fm) continue;
    if (fm.title) titles.add(String(fm.title).split(" - ")[0].trim());
    if (fm.aliases) {
      const noteAliases = Array.isArray(fm.aliases) ? fm.aliases : [fm.aliases];
      for (const alias of noteAliases) aliases.add(alias);
    }
  }

  const broken = [];
  for (const note of notes) {
    if (note.rel.startsWith("99_Templates/")) continue;
    for (const link of findWikilinks(note.content)) {
      if (basenames.has(link) || aliases.has(link) || titles.has(link)) continue;
      if (PLACEHOLDER_LINKS.has(link)) continue;
      if (link.includes("/") || link.startsWith(".")) continue;
      if (/^(ADR|Mistake|YYYY-MM-DD|G-NNN|Runbook-NNN|Template-NNN|NNN)/.test(link)) continue;
      if (link === "AGENTS.md" || link === "MOC-Home.md") continue;
      broken.push(`${note.rel} -> [[${link}]]`);
    }
  }

  return broken;
}

function findMultiAiAcceptance(notes) {
  const note = notes.find((item) => item.base === "Multi-AI-Acceptance-Results");
  if (!note) {
    return { present: false, passed: 0, pending: 0, failed: 0, skipped: 0 };
  }

  const rows = note.content
    .split(/\r?\n/)
    .filter((line) => /^\|\s*(Codex|Claude Code|Cursor|Cascade|Windsurf|Copilot|opencode)\s*\|/i.test(line));

  let passed = 0;
  let pending = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim().toLowerCase());
    const status = cells[2] ?? "";
    if (status.includes("pass")) passed += 1;
    else if (status.includes("fail")) failed += 1;
    else if (status.includes("skip")) skipped += 1;
    else pending += 1;
  }

  return { present: true, passed, pending, failed, skipped };
}

function grade(score) {
  if (score >= 95) return "A";
  if (score >= 85) return "B";
  if (score >= 75) return "C";
  if (score >= 60) return "D";
  return "F";
}

function parseMinScoreArg() {
  const arg = process.argv.find((item) => item.startsWith("--min="));
  if (!arg) return null;
  const raw = arg.slice("--min=".length);
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const notes = readAllNotes();
const withFrontmatter = notes.filter((note) => note.fm);
const missingFrontmatter = notes.filter((note) => !note.fm && !["README", "AGENTS", "AGENT-IDENTITY"].includes(note.base));
const byType = new Map();
const staleUpdated = [];
const staleVerified = [];
const sourceCandidates = [];
const notesMissingSource = [];
const sessionFollowUps = [];
const openMistakes = [];

for (const note of withFrontmatter) {
  const type = note.fm.type || "note";
  const isTemplate = note.rel.startsWith("99_Templates/");
  byType.set(type, (byType.get(type) ?? 0) + 1);

  const status = String(note.fm.status ?? "active");
  const isArchived = status === "archived";
  const updated = parseDate(note.fm.updated);
  if (!isArchived && updated && ageDays(updated) > 90) {
    staleUpdated.push(note.rel);
  }

  const lastVerified = parseDate(note.fm["last-verified"]);
  if (!isArchived && lastVerified && ageDays(lastVerified) > 90) {
    staleVerified.push(note.rel);
  }

  if (!isTemplate && !isArchived && SOURCE_CANDIDATE_TYPES.has(type)) {
    sourceCandidates.push(note.rel);
    if (!note.fm.source || !note.fm["last-verified"] || !note.fm["verified-by"] || !note.fm.confidence) {
      notesMissingSource.push(note.rel);
    }
  }

  if (!isTemplate && type === "session-log") {
    const unchecked = listUncheckedTasks(note.content);
    if (unchecked.length > 0) {
      sessionFollowUps.push({ rel: note.rel, count: unchecked.length });
    }
  }

  if (!isTemplate && type === "mistake" && status === "open") {
    openMistakes.push(note.rel);
  }
}

const brokenLinks = findBrokenLinks(notes);
const multiAi = findMultiAiAcceptance(notes);
const sessionFollowUpCount = sessionFollowUps.reduce((sum, item) => sum + item.count, 0);

const deductions = [
  { label: "missing frontmatter", count: missingFrontmatter.length, weight: 4 },
  { label: "broken wikilinks", count: brokenLinks.length, weight: 5 },
  { label: "stale updated dates", count: staleUpdated.length, weight: 2, cap: 10 },
  { label: "stale verified dates", count: staleVerified.length, weight: 3, cap: 10 },
  { label: "source-candidate notes missing truth fields", count: notesMissingSource.length, weight: 2, cap: 10 },
  { label: "open mistake entries", count: openMistakes.length, weight: 2, cap: 5 },
  { label: "unchecked session follow-ups", count: sessionFollowUpCount, weight: 1, cap: 10 },
  { label: "multi-AI pending results", count: multiAi.pending + (multiAi.present ? 0 : 1), weight: 2, cap: 5 },
  { label: "multi-AI failed results", count: multiAi.failed, weight: 5 },
];

const score = Math.max(0, 100 - deductions.reduce((sum, item) => {
  const counted = Math.min(item.count, item.cap ?? item.count);
  return sum + counted * item.weight;
}, 0));
const minScore = parseMinScoreArg();
const typeRows = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));

console.log("");
console.log("Memory Quality Score");
console.log(`Vault: ${VAULT}`);
console.log(`Score: ${score}/100 (${grade(score)})`);
console.log("-".repeat(60));
console.log(`Markdown files: ${notes.length}`);
console.log(`Files with frontmatter: ${withFrontmatter.length}`);
console.log(`Source-candidate notes: ${sourceCandidates.length}`);
console.log(`Notes missing truth fields: ${notesMissingSource.length}`);
console.log(`Broken wikilinks: ${brokenLinks.length}`);
console.log(`Stale updated dates (>90d): ${staleUpdated.length}`);
console.log(`Stale last-verified dates (>90d): ${staleVerified.length}`);
console.log(`Open mistakes: ${openMistakes.length}`);
console.log(`Unchecked session follow-ups: ${sessionFollowUpCount}`);
console.log(`Multi-AI acceptance: ${multiAi.passed} pass, ${multiAi.pending} pending, ${multiAi.failed} fail, ${multiAi.skipped} skipped`);
console.log("-".repeat(60));
console.log("Notes by type:");
for (const [type, count] of typeRows) {
  console.log(`  ${type}: ${count}`);
}

function printList(label, items, limit = 8) {
  if (items.length === 0) return;
  console.log("");
  console.log(`${label} (${items.length}):`);
  for (const item of items.slice(0, limit)) {
    console.log(`  - ${typeof item === "string" ? item : `${item.rel} (${item.count})`}`);
  }
  if (items.length > limit) console.log(`  ... ${items.length - limit} more`);
}

printList("Missing frontmatter", missingFrontmatter.map((note) => note.rel));
printList("Broken wikilinks", brokenLinks);
printList("Notes missing source/last-verified/verified-by/confidence", notesMissingSource);
printList("Open mistakes", openMistakes);
printList("Session logs with unchecked tasks", sessionFollowUps);

console.log("");
console.log("Result: memory quality summary complete.");

if (minScore !== null && score < minScore) {
  console.error(`Score ${score} is below required minimum ${minScore}.`);
  process.exit(2);
}
