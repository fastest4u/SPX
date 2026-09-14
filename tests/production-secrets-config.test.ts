import assert from "node:assert/strict";
import { validateProductionSecrets } from "../src/config/env.js";

assert.throws(
  () => validateProductionSecrets({ NODE_ENV: "production", SECRETS_KEY: "" }),
  /SECRETS_KEY.*at least 32/,
);
assert.throws(
  () => validateProductionSecrets({ NODE_ENV: "production", SECRETS_KEY: "short" }),
  /SECRETS_KEY.*at least 32/,
);
assert.doesNotThrow(() =>
  validateProductionSecrets({ NODE_ENV: "production", SECRETS_KEY: "x".repeat(32) }),
);
assert.doesNotThrow(() =>
  validateProductionSecrets({ NODE_ENV: "development", SECRETS_KEY: "" }),
);
