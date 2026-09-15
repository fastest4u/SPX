import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as {
  DEFAULT_SCHEMA: { extend: (types: unknown[]) => unknown };
  Type: new (tag: string, options: { construct: (value: unknown) => unknown; kind: string }) => unknown;
  load: (source: string, options?: { schema: unknown }) => unknown;
};
interface ComposeService {
  depends_on?: unknown;
  entrypoint?: string[];
  environment?: Record<string, string>;
  expose?: unknown;
  image?: string;
  ports?: unknown;
  profiles?: string[];
  read_only?: boolean;
  restart?: string;
}
interface ComposeDocument {
  configs?: Record<string, unknown>;
  networks?: unknown;
  secrets?: Record<string, unknown>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}
const composeOverride = new yaml.Type("!override", {
  construct: (value) => value,
  kind: "sequence",
});
const composeSchema = yaml.DEFAULT_SCHEMA.extend([composeOverride]);
const readYaml = (path: string): ComposeDocument => yaml.load(
  readFileSync(resolve(path), "utf8"),
  { schema: composeSchema },
) as ComposeDocument;

const primary = readYaml("deploy/production-primary.yml");
assert.deepEqual(Object.keys(primary), ["services"]);
assert.deepEqual(Object.keys(primary.services), ["notifier", "worker-ifn", "worker-ptwl", "worker-ifn-split"]);
for (const service of ["notifier", "worker-ifn", "worker-ptwl"]) {
  assert.deepEqual(primary.services[service].profiles, ["forbidden-primary-legacy"]);
  assert.deepEqual(primary.services[service].entrypoint, ["/bin/false"]);
  assert.equal(primary.services[service].restart, "no");
}
assert.deepEqual(primary.services["worker-ifn-split"].profiles, ["forbidden-primary-team2"]);
assert.deepEqual(primary.services["worker-ifn-split"].entrypoint, ["/bin/false"]);
assert.equal(primary.services["worker-ifn-split"].restart, "no");

const team2 = readYaml("deploy/production-team2.yml");
assert.deepEqual(Object.keys(team2.services), ["worker-ifn-split"]);
assert.deepEqual(team2.services["worker-ifn-split"].profiles, ["split"]);
assert.equal(team2.services["worker-ifn-split"].image, "${SPX_IMAGE:?SPX_IMAGE is required}");
assert.equal(team2.services["worker-ifn-split"].read_only, true);
assert.equal(team2.services["worker-ifn-split"].environment.SPX_ROLE, "worker");
assert.equal(team2.services["worker-ifn-split"].environment.SPX_NODE_ID, "prod-worker-ifn-node2");
assert.equal(team2.services["worker-ifn-split"].environment.RUN_TEAM_IDS, "2");
assert.equal(
  team2.services["worker-ifn-split"].environment.NOTIFIER_API_URL,
  "${SPX_TEAM2_NOTIFICATION_API_URL:?SPX_TEAM2_NOTIFICATION_API_URL is required}",
);
assert.equal(team2.services["worker-ifn-split"].environment.HTTP_ENABLED, "false");
assert.equal(team2.services["worker-ifn-split"].ports, undefined);
assert.equal(team2.services["worker-ifn-split"].expose, undefined);
assert.equal(team2.services["worker-ifn-split"].depends_on, undefined);
assert.deepEqual(Object.keys(team2.configs).sort(), [
  "spx_deployment_context",
  "spx_release_manifest",
  "spx_target_descriptor",
]);
assert.deepEqual(Object.keys(team2.secrets).sort(), [
  "db_password_worker_ifn_split",
  "notification_node_secret_worker_ifn_split",
  "realtime_shared_secret_worker_ifn_split",
  "secrets_key",
]);
assert.deepEqual(Object.keys(team2.volumes), ["spool-worker-ifn-split"]);
assert.equal(team2.networks, undefined);

const source = readFileSync(resolve("deploy/production-team2.yml"), "utf8");
const primarySource = readFileSync(resolve("deploy/production-primary.yml"), "utf8");
assert.match(primarySource, /profiles:\s*!override\s+\["forbidden-primary-team2"\]/);
assert.doesNotMatch(source, /worker-ptwl|web-api|notification-service|line-service|ocr-service|migrator/);
assert.doesNotMatch(source, /0\.0\.0\.0|ports:|expose:/);
assert.match(source, /cap_drop:\r?\n\s+- ALL/);
assert.match(source, /no-new-privileges:true/);

console.log("production topology compose: primary deny overlay and isolated TEAM 2 worker pass");
