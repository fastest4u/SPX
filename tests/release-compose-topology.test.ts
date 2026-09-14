import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const source = readFileSync(resolve(root, "docker-compose.a3.yml"), "utf8");

function serviceBlock(serviceName: string): string {
  const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^  ${escaped}:\\s*$`, "m").exec(source);
  assert.ok(header, `compose service ${serviceName} must exist`);
  const afterHeader = header.index + header[0].length;
  const remainder = source.slice(afterHeader);
  const nextService = /^ {2}[a-zA-Z0-9][a-zA-Z0-9_-]*:\s*$/m.exec(remainder);
  return source.slice(header.index, nextService ? afterHeader + nextService.index : source.length);
}

assert.match(source, /^x-spx-image: &spx-image\r?\n {2}image: \$\{SPX_IMAGE:\?SPX_IMAGE is required\}$/m);
assert.doesNotMatch(source, /^\s*build:/m, "production Compose must not build on the target host");
assert.doesNotMatch(source, /image:\s*spx-app:latest/, "production Compose must not use a mutable image tag");
assert.doesNotMatch(
  source,
  /node dist\/scripts\/db-migrate\.js && exec node dist\/app\.js/,
  "application services must never own schema migration",
);
assert.doesNotMatch(source, /docker compose[^\n]*--build/, "operator commands must use the immutable release image");

const common = source.match(/^x-spx-common: &spx-common[\s\S]*?(?=^x-spx-)/m)?.[0] ?? "";
assert.match(common, /^ {2}<<: \*spx-image$/m, "all application runtimes must inherit the immutable image");
assert.match(common, /^ {2}configs:\r?\n {4}- source: spx_release_manifest$/m);

const migrator = serviceBlock("migrator");
assert.match(migrator, /^ {4}<<: \*spx-common$/m);
assert.match(migrator, /^ {4}profiles: \["migration"\]$/m);
assert.match(migrator, /^ {4}restart: "no"$/m);
assert.match(migrator, /^ {6}SPX_ROLE: migrator$/m);
assert.match(migrator, /^ {4}command: \["node", "dist\/scripts\/db-migrate\.js"\]$/m);
assert.doesNotMatch(migrator, /^ {4}(?:ports|expose|healthcheck):/m);

assert.match(source, /^configs:\r?\n {2}spx_release_manifest:\r?\n {4}file: \$\{SPX_RELEASE_MANIFEST_PATH:\?SPX_RELEASE_MANIFEST_PATH is required\}$/m);

console.log("release-compose-topology: all assertions passed");
