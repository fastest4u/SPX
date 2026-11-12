import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

assert.doesNotMatch(
  packageJson.scripts["dev:memory"] ?? "",
  /\bcp\s+\.env\.test\s+\.env\b/,
  "dev:memory must never overwrite a developer's .env file",
);
assert.equal(
  existsSync(resolve(root, "scripts/dev-memory.mjs")),
  true,
  "scripts/dev-memory.mjs must exist for safe in-memory dev startup",
);

const frontendOnlyPackages = [
  "@radix-ui/react-dialog",
  "@radix-ui/react-label",
  "@radix-ui/react-slot",
  "@tanstack/react-query",
  "@tanstack/react-router",
  "@tanstack/router-devtools",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "qrcode.react",
  "react",
  "react-dom",
  "recharts",
  "sonner",
  "tailwind-merge",
  "tailwindcss-animate",
];

for (const pkg of frontendOnlyPackages) {
  assert.equal(
    pkg in packageJson.dependencies,
    false,
    `${pkg} is bundled by Vite and must not bloat production container dependencies`,
  );
  assert.equal(
    pkg in packageJson.devDependencies,
    true,
    `${pkg} must remain available in devDependencies for Vite builds and tests`,
  );
}

console.log("package-hygiene: all assertions passed");
