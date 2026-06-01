import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat ESLint config tuned as a bug-catcher, not a formatter.
 * Formatting is delegated to Prettier (.prettierrc.json) so lint and format
 * do not fight each other. Generated and non-source trees are ignored.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "data/**",
      "logs/**",
      "memory/**",
      "coverage/**",
      "**/*.gen.ts",
      // IDE / agent automation hooks (per-tool, not application source).
      ".codex/**",
      ".cursor/**",
      ".windsurf/**",
      ".agents/**",
      // Legacy root scratch scripts kept for reference; real work lives in src/.
      "test-api.js",
      "test-api.ts",
      "poll-bidding.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Bug-catcher posture: keep documented `any` and unused symbols visible as
    // warnings (advisory tech-debt) rather than hard errors that block CI.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Empty catch blocks are a deliberate pattern here (best-effort cleanup).
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["src/frontend/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // shadcn/ui-style components legitimately declare empty supertype interfaces.
    files: ["src/frontend/components/ui/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    // Dual-driver (MySQL + SQLite) shim deliberately opts out of strict typing.
    files: ["src/db/client-memory.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
    },
  },
);
