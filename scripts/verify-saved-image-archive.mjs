import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_ID = /^sha256:([0-9a-f]{64})$/;
const IMAGE_TAG = /^spx-app:[0-9a-f]{40}$/;
const LEGACY_LAYER = /^[0-9a-f]{64}\/layer\.tar$/;
const CONTENT_ADDRESSED_LAYER = /^blobs\/sha256\/[0-9a-f]{64}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function verifySavedImageArchiveManifest(value, identity) {
  const imageId = identity?.imageId;
  const imageTag = identity?.imageTag;
  const digest = IMAGE_ID.exec(imageId ?? "")?.[1];
  if (!digest || !IMAGE_TAG.test(imageTag ?? "")) {
    throw new Error("saved image identity is invalid");
  }
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) {
    throw new Error("saved image archive must contain exactly one manifest entry");
  }
  const entry = value[0];
  const legacyConfig = `${digest}.json`;
  const contentAddressedConfig = `blobs/sha256/${digest}`;
  const layout = entry.Config === legacyConfig
    ? "legacy"
    : entry.Config === contentAddressedConfig
      ? "content-addressed"
      : null;
  if (layout === null) throw new Error("saved image archive config does not match image ID");
  if (
    !Array.isArray(entry.RepoTags)
    || entry.RepoTags.length !== 1
    || entry.RepoTags[0] !== imageTag
  ) throw new Error("saved image archive tag does not match release tag");
  if (!Array.isArray(entry.Layers) || entry.Layers.length === 0) {
    throw new Error("saved image archive layer set is invalid");
  }
  const layerPattern = layout === "legacy" ? LEGACY_LAYER : CONTENT_ADDRESSED_LAYER;
  if (entry.Layers.some((layer) => typeof layer !== "string" || !layerPattern.test(layer))) {
    throw new Error("saved image archive layer layout is invalid");
  }
  return Object.freeze({ layout, layerCount: entry.Layers.length });
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("saved image verifier arguments are invalid");
    values[match[1]] = match[2];
  }
  if (Object.keys(values).sort().join(",") !== "image-id,image-tag,manifest") {
    throw new Error("saved image verifier arguments are incomplete");
  }
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  const result = verifySavedImageArchiveManifest(manifest, {
    imageId: args["image-id"],
    imageTag: args["image-tag"],
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
