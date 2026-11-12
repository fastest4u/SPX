import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const deployWorkflow = readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8");
const prodStatusSkill = readFileSync(resolve(root, ".agents/skills/spx-prod-status/SKILL.md"), "utf8");
const agentsGuide = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const eslintConfig = readFileSync(resolve(root, "eslint.config.mjs"), "utf8");

// 1. Legacy deploy on Primary must also refresh line-service (--no-deps) and preserve it on rollback
assert.match(
  deployWorkflow,
  /detect_legacy_line_service\(\)/,
  "deploy.yml must detect whether line-service is active alongside legacy notifier on Primary",
);
assert.match(
  deployWorkflow,
  /compose_up_current\(\)[\s\S]*?docker compose up -d --force-recreate notifier worker-krtk[\s\S]*?docker compose --profile split up -d --no-deps --force-recreate line-service/,
  "legacy compose_up_current must recreate an active line-service container with --no-deps so web-api is not started",
);
assert.match(
  deployWorkflow,
  /rollback_legacy\(\)[\s\S]*?docker compose --profile split up -d --no-deps --force-recreate line-service/,
  "rollback_legacy must restore an active line-service container instead of leaving it stopped",
);
assert.match(
  deployWorkflow,
  /wait_current_readiness\(\)[\s\S]*?ROLLBACK_LINE_SERVICE_ACTIVE[\s\S]*?line-service/,
  "wait_current_readiness must verify line-service health when active in legacy topology",
);

// 2. spx-prod-status SKILL.md must use 45.83.207.139:3306 and include spx-worker-krtk-1 in Step 5
assert.doesNotMatch(
  prodStatusSkill,
  /210\.246\.215\.212/,
  "spx-prod-status SKILL.md must not reference retired DB IP 210.246.215.212",
);
assert.equal(
  (prodStatusSkill.match(/45\.83\.207\.139:3306/g) ?? []).length >= 2,
  true,
  "spx-prod-status SKILL.md must document direct MySQL connection to 45.83.207.139:3306 for both remote workers",
);
const step5Section = prodStatusSkill.split("## Step 5:")[1] ?? "";
assert.match(
  step5Section,
  /`spx-worker-krtk-1`/,
  "Step 5 summary template must include spx-worker-krtk-1 on Primary",
);

// 3. AGENTS.md must accurately document ESLint (`npm run lint`) and test runner (`npm test` / `TEST_CONCURRENCY`)
assert.doesNotMatch(
  agentsGuide,
  /No ESLint or Prettier config exists/i,
  "AGENTS.md must not claim ESLint config is absent when eslint.config.mjs is active",
);
assert.doesNotMatch(
  agentsGuide,
  /There is no unit-test framework configured/i,
  "AGENTS.md must not claim there is no test runner when scripts/run-tests.mjs runs tests/*.test.ts",
);
assert.match(agentsGuide, /`npm run lint`/, "AGENTS.md must document npm run lint");
assert.match(agentsGuide, /`npm test`/, "AGENTS.md must document npm test");
assert.match(agentsGuide, /TEST_CONCURRENCY/, "AGENTS.md must document bounded concurrency in scripts/run-tests.mjs");
assert.match(agentsGuide, /memory_sessionStart/, "AGENTS.md must preserve Project Memory V2 instructions");
assert.match(agentsGuide, /<!-- context7 -->/, "AGENTS.md must preserve Context7 instructions");
assert.match(eslintConfig, /\.superpowers\/\*\*/, "eslint.config.mjs must ignore .superpowers/**");
assert.match(eslintConfig, /\.worktrees\/\*\*/, "eslint.config.mjs must ignore .worktrees/**");
assert.match(eslintConfig, /memory-v2\/\*\*/, "eslint.config.mjs must ignore memory-v2/**");

console.log("task7-ops-and-docs: all assertions passed");
