#!/usr/bin/env node
// memory-eval.mjs - deterministic retrieval coverage test for the SPX Memory Vault.
//
// This does not grade an AI model. It verifies that the vault contains enough
// source-grounded notes and terms for an agent to answer the core questions.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const VAULT = join(ROOT, "memory");

function* walkMd(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkMd(full);
    else if (name.endsWith(".md")) yield full;
  }
}

const filesByBase = new Map(
  [...walkMd(VAULT)].map((file) => [basename(file, ".md"), file]),
);

function notePath(base) {
  return filesByBase.get(base) ?? null;
}

function noteText(base) {
  const file = notePath(base);
  return file ? readFileSync(file, "utf8") : "";
}

function includesTerm(text, term) {
  return text.toLowerCase().includes(term.toLowerCase());
}

const evals = [
  {
    question: "How should an Awakened AI operate in SPX?",
    notes: ["Awakened-AI-System", "AGENTS", "AGENT-IDENTITY"],
    terms: ["Orient -> Retrieve -> Inspect source -> Act -> Verify -> Log -> Update memory", "self-check", "session log"],
  },
  {
    question: "How does the whole SPX runtime work?",
    notes: ["SPX-System-Map", "SPX-Project-Rules"],
    terms: ["Poller", "Fastify", "app_settings", "auto_accept_history"],
  },
  {
    question: "Where are settings stored and how do they apply?",
    notes: ["SPX-System-Map", "SPX-Project-Rules", "ADR-002-DB-Backed-Live-Settings"],
    terms: ["app_settings", "reloadSettingsLive", "SettingsController"],
  },
  {
    question: "What should an agent do when the upstream SPX session expires?",
    notes: ["Runbook-API-Session-Expired", "API-SSE-Events"],
    terms: ["session-expired", "COOKIE", "Settings"],
  },
  {
    question: "How does auto-accept avoid over-accepting?",
    notes: ["Component-Poller-Orchestration", "Runbook-Auto-Accept-Debug"],
    terms: ["NeedBudget", "auto_accept_history", "request_id"],
  },
  {
    question: "How are notify rules stored across dev and prod?",
    notes: ["Component-Dual-Storage-Notify-Rules", "ADR-001-Dual-Storage-Notify-Rules"],
    terms: ["notify-rules.json", "notify_rules", "migrateJsonToDb"],
  },
  {
    question: "How should production schema drift be checked?",
    notes: ["Runbook-Production-Schema-Verification", "Runbook-DB-Migration"],
    terms: ["schema_migrations", "information_schema.columns", "spx_booking_history"],
  },
  {
    question: "How do we test multi-agent memory acceptance?",
    notes: ["Runbook-Multi-AI-Memory-Acceptance", "Memory-Evaluation-Test"],
    terms: ["Claude Code", "Cursor", "Cascade", "memory:eval"],
  },
];

let passed = 0;
const failures = [];

for (const item of evals) {
  const missingNotes = item.notes.filter((note) => !existsSync(notePath(note) ?? ""));
  const combined = item.notes.map(noteText).join("\n");
  const missingTerms = item.terms.filter((term) => !includesTerm(combined, term));

  if (missingNotes.length === 0 && missingTerms.length === 0) {
    passed += 1;
    continue;
  }

  failures.push({
    question: item.question,
    missingNotes,
    missingTerms,
  });
}

const total = evals.length;
const score = Math.round((passed / total) * 100);

console.log("\nAwakened AI Memory Evaluation");
console.log(`Vault: ${VAULT}`);
console.log(`Score: ${score}% (${passed}/${total})`);
console.log("-".repeat(60));

for (const item of evals) {
  const failed = failures.find((failure) => failure.question === item.question);
  const marker = failed ? "FAIL" : "PASS";
  console.log(`${marker} ${item.question}`);
  if (failed) {
    if (failed.missingNotes.length > 0) {
      console.log(`  Missing notes: ${failed.missingNotes.join(", ")}`);
    }
    if (failed.missingTerms.length > 0) {
      console.log(`  Missing terms: ${failed.missingTerms.join(", ")}`);
    }
  } else {
    const rels = item.notes
      .map((note) => notePath(note))
      .filter(Boolean)
      .map((file) => relative(ROOT, file).replace(/\\/g, "/"));
    console.log(`  Evidence: ${rels.join(", ")}`);
  }
}

console.log("-".repeat(60));

if (failures.length > 0) {
  console.log("Result: memory evaluation failed.");
  process.exit(2);
}

console.log("Result: memory evaluation passed.");
