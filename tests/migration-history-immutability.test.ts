import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const migrationsDirectory = resolve(process.cwd(), "migrations");
const manifestPath = resolve(migrationsDirectory, "released-checksums.json");
const approved = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
const files = readdirSync(migrationsDirectory)
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right));
const sequences = files.map((name) => name.slice(0, 3));

assert.equal(new Set(sequences).size, sequences.length, "migration sequence numbers must be unique");
assert.deepEqual(
  Object.keys(approved).sort((left, right) => left.localeCompare(right)),
  files,
  "every released migration must have exactly one approved checksum",
);

for (const [name, checksum] of Object.entries(approved)) {
  assert.match(checksum, /^[0-9a-f]{64}$/, `${name} must use a lowercase SHA-256 checksum`);
  const actual = createHash("sha256")
    .update(readFileSync(resolve(migrationsDirectory, name)))
    .digest("hex");
  assert.equal(actual, checksum, `${name} is immutable after approval`);
}

console.log(`migration-history-immutability: ${files.length} frozen migrations verified`);
