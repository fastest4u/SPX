import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Thrift, Protocols } from "@evex/linejs/thrift";

const require = createRequire(import.meta.url);
const thriftPackage = require("thrift/package.json") as { version: string };

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map((part) => Number(part));
  const minimumParts = minimum.split(".").map((part) => Number(part));
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

assert.equal(
  versionAtLeast(thriftPackage.version, "0.23.0"),
  true,
  `Expected thrift >= 0.23.0 to include patched advisory fixes, got ${thriftPackage.version}`,
);

const lineThrift = new Thrift();
const encoded = lineThrift.writeThrift(
  [
    [11, 1, "hello"], // STRING
    [8, 2, 42], // I32
  ],
  "compat",
  Protocols[4],
);
const decoded = lineThrift.readThrift(Buffer.from(encoded), Protocols[4]);

assert.equal(decoded.data[1], "hello");
assert.equal(decoded.data[2], 42);

console.log("linejs-thrift-compat: all assertions passed");
