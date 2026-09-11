import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootSource = readFileSync(resolve(process.cwd(), "src/frontend/routes/__root.tsx"), "utf8");
const layoutSource = readFileSync(
  resolve(process.cwd(), "src/frontend/components/layout/AppLayout.tsx"),
  "utf8",
);
const userE2eSource = readFileSync(resolve(process.cwd(), "tests/user-ui-e2e.test.ts"), "utf8");
const adminE2eSource = readFileSync(resolve(process.cwd(), "tests/admin-ui-e2e.test.ts"), "utf8");

assert.match(
  rootSource,
  /ADMIN_ONLY_PATHS[\s\S]*?['"]\/line-image-extractions['"]/,
  "LINE runsheet route must redirect non-admin users",
);

const commonNav = layoutSource.slice(
  layoutSource.indexOf("const navItems"),
  layoutSource.indexOf("const adminNavItems"),
);
const adminNav = layoutSource.slice(
  layoutSource.indexOf("const adminNavItems"),
  layoutSource.indexOf("const mobileTabs"),
);
const mobileTabs = layoutSource.slice(
  layoutSource.indexOf("const mobileTabs"),
  layoutSource.indexOf("const pageLabels"),
);
assert.doesNotMatch(commonNav, /\/line-image-extractions/);
assert.match(adminNav, /\/line-image-extractions/);
assert.doesNotMatch(mobileTabs, /\/line-image-extractions/);
assert.doesNotMatch(userE2eSource, /path:\s*["']\/line-image-extractions["']/);
assert.match(adminE2eSource, /path:\s*["']\/line-image-extractions["']/);
