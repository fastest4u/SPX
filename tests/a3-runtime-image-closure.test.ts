import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix } from "node:path";

const dockerfile = readFileSync("Dockerfile.a3", "utf8");
const copied = new Set([...dockerfile.matchAll(/^COPY(?: --[^ ]+)* ([a-zA-Z][^ ]+) /gm)]
  .map((match) => match[1]));
for (const path of copied) {
  if (!/\.(?:mjs|ts)$/.test(path)) continue;
  assert.equal(existsSync(path), true, `${path} must exist at image build time`);
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
    const dependency = posix.normalize(posix.join(dirname(path).replaceAll("\\", "/"), match[1]));
    assert.equal(copied.has(dependency), true, `${path} needs ${dependency} in the runtime image`);
  }
}
const release = readFileSync(".github/workflows/release-artifact.yml", "utf8");
assert.match(release, /build-operator-bundle\.mjs build[\s\S]*?--topology=a3/);
assert.match(release, /docker build[\s\S]*?--file Dockerfile\.a3/);
console.log("A3 runtime image includes its local module closure and is selected by the candidate release");
