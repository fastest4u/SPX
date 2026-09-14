import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSchemaCompatible } from "../src/services/release-manifest.js";

const released = JSON.parse(
  readFileSync("migrations/released-checksums.json", "utf8"),
) as Record<string, string>;
const highest = Math.max(...Object.keys(released).map((name) => Number(name.slice(0, 3))));
assert.equal(highest, 44, "compatibility fixtures must follow the exact candidate migration maximum");
assert.deepEqual(
  assertSchemaCompatible({ current: highest, min: 35, max: highest, failed: [] }),
  { current: highest },
);
assert.deepEqual(
  assertSchemaCompatible({ current: 35, min: 35, max: highest, failed: [] }),
  { current: 35 },
);
assert.throws(
  () => assertSchemaCompatible({ current: highest, min: 33, max: highest - 1, failed: [] }),
  /too new/,
);
assert.throws(
  () => assertSchemaCompatible({ current: highest - 1, min: highest, max: highest, failed: [] }),
  /too old/,
);
assert.throws(
  () => assertSchemaCompatible({ current: highest, min: 35, max: highest, failed: [String(highest)] }),
  /failed migration/,
);
assert.match(
  released["035_create_auto_accept_publication_controls.sql"] ?? "",
  /^[0-9a-f]{64}$/,
);
assert.match(
  released["036_create_gate6_control_plane.sql"] ?? "",
  /^[0-9a-f]{64}$/,
);
assert.match(
  released["037_create_n_minus_one_probe_fixtures.sql"] ?? "",
  /^[0-9a-f]{64}$/,
);

console.log("schema-compatibility: released migration range assertions passed");
