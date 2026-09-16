import assert from "node:assert/strict";

import { verifySavedImageArchiveManifest } from "../scripts/verify-saved-image-archive.mjs";

const digest = "a".repeat(64);
const imageId = `sha256:${digest}`;
const imageTag = `spx-app:${"b".repeat(40)}`;

const legacy = [{
  Config: `${digest}.json`,
  RepoTags: [imageTag],
  Layers: [`${"c".repeat(64)}/layer.tar`],
}];
const contentAddressed = [{
  Config: `blobs/sha256/${digest}`,
  RepoTags: [imageTag],
  Layers: [`blobs/sha256/${"d".repeat(64)}`],
}];

assert.deepEqual(verifySavedImageArchiveManifest(legacy, { imageId, imageTag }), {
  layout: "legacy",
  layerCount: 1,
});
assert.deepEqual(verifySavedImageArchiveManifest(contentAddressed, { imageId, imageTag }), {
  layout: "content-addressed",
  layerCount: 1,
});

assert.throws(
  () => verifySavedImageArchiveManifest([{ ...contentAddressed[0], Config: `blobs/sha256/${"e".repeat(64)}` }], { imageId, imageTag }),
  /config/i,
);
assert.throws(
  () => verifySavedImageArchiveManifest([{ ...contentAddressed[0], RepoTags: ["spx-app:wrong"] }], { imageId, imageTag }),
  /tag/i,
);
assert.throws(
  () => verifySavedImageArchiveManifest([{ ...contentAddressed[0], Layers: ["../../escape"] }], { imageId, imageTag }),
  /layer/i,
);
assert.throws(
  () => verifySavedImageArchiveManifest([{ ...contentAddressed[0], Layers: [`${"f".repeat(64)}/layer.tar`] }], { imageId, imageTag }),
  /layout/i,
);

console.log("saved image archive identity tests passed");
