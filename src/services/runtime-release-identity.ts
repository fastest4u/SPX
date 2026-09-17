import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";

import {
  assembleSignedDeploymentTargetDescriptor,
  deploymentTargetDescriptorArtifactSha256,
  type DeploymentTargetDescriptorInput,
} from "./deployment-target-descriptor.js";
import {
  buildBuildManifest,
  canonicalJson,
  finalizeReleaseManifest,
  sha256Hex,
  type BuildManifestInput,
} from "./release-manifest.js";

export const RUNTIME_BUILD_MANIFEST_PATH = "/app/build-manifest.json";
export const RUNTIME_RELEASE_MANIFEST_PATH = "/run/secrets/spx-release-manifest";
export const RUNTIME_TARGET_DESCRIPTOR_PATH = "/run/secrets/spx-target-descriptor";
export const RUNTIME_DEPLOYMENT_CONTEXT_PATH = "/run/secrets/spx-deployment-context";

const MAX_IDENTITY_FILE_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RuntimeReleaseIdentity {
  version: string;
  gitSha: string;
  buildId: string;
  environment: "staging" | "production";
  topology: "legacy" | "split";
  imageId: string;
  imageTag: string;
  targetDescriptorSha256: string;
  operatorBundleSha256: string;
}

export interface RuntimeNodeReleaseRegistration {
  version: string;
  metadata: Omit<RuntimeReleaseIdentity, "version"> & { startedAt: string };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readCanonicalJson(path: string, label: string): {
  bytes: Buffer;
  value: Record<string, unknown>;
} {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.size < 2n
      || before.size > BigInt(MAX_IDENTITY_FILE_BYTES)
    ) {
      throw new Error("invalid identity file");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("identity file changed before read");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.length)) {
      throw new Error("identity file changed during read");
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || !bytes.equals(Buffer.from(canonicalJson(value), "utf8"))
    ) {
      throw new Error("identity JSON is not canonical");
    }
    return { bytes, value: value as Record<string, unknown> };
  } catch {
    throw new Error(`${label} could not be verified`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close invalidates no already-returned immutable bytes on supported platforms.
      }
    }
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match immutable release identity`);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function isLegacyDeployment(): boolean {
  try {
    const candidates = [
      "dist/deployment-contract.json",
      "deploy/runtime-deployment-contract.json",
      "/app/dist/deployment-contract.json",
    ];
    for (const candidate of candidates) {
      try {
        const stat = lstatSync(candidate);
        if (stat.isFile()) {
          const content = JSON.parse(readFileSync(candidate, "utf8")) as { mode?: unknown };
          if (content?.mode === "legacy") return true;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function loadRuntimeReleaseIdentity(options: {
  buildManifestPath: string;
  releaseManifestPath: string;
  targetDescriptorPath: string;
  deploymentContextPath: string;
}): Readonly<RuntimeReleaseIdentity>;
export function loadRuntimeReleaseIdentity(options?: {
  buildManifestPath?: string;
  releaseManifestPath?: string;
  targetDescriptorPath?: string;
  deploymentContextPath?: string;
}): Readonly<RuntimeReleaseIdentity> | undefined;
export function loadRuntimeReleaseIdentity(options: {
  buildManifestPath?: string;
  releaseManifestPath?: string;
  targetDescriptorPath?: string;
  deploymentContextPath?: string;
} = {}): Readonly<RuntimeReleaseIdentity> | undefined {
  const isExplicit = Boolean(
    options.buildManifestPath ||
    options.releaseManifestPath ||
    options.targetDescriptorPath ||
    options.deploymentContextPath
  );

  const buildManifestPath = options.buildManifestPath ?? RUNTIME_BUILD_MANIFEST_PATH;
  const releaseManifestPath = options.releaseManifestPath ?? RUNTIME_RELEASE_MANIFEST_PATH;

  if (!isExplicit) {
    let hasBuild = false;
    let hasRelease = false;
    try {
      hasBuild = lstatSync(buildManifestPath).isFile();
    } catch {}
    try {
      hasRelease = lstatSync(releaseManifestPath).isFile();
    } catch {}

    if (!hasBuild || !hasRelease || isLegacyDeployment()) {
      return undefined;
    }
  }

  const buildFile = readCanonicalJson(
    buildManifestPath,
    "build manifest",
  );
  const releaseFile = readCanonicalJson(
    releaseManifestPath,
    "release manifest",
  );
  const targetFile = readCanonicalJson(
    options.targetDescriptorPath ?? RUNTIME_TARGET_DESCRIPTOR_PATH,
    "target descriptor",
  );
  const contextFile = readCanonicalJson(
    options.deploymentContextPath ?? RUNTIME_DEPLOYMENT_CONTEXT_PATH,
    "deployment context",
  );

  const build = buildBuildManifest(buildFile.value as unknown as BuildManifestInput);
  if (canonicalJson(build) !== buildFile.bytes.toString("utf8")) {
    throw new Error("build manifest does not match canonical release fields");
  }
  const {
    imageId,
    imageTag,
    buildManifestSha256,
    ...releaseBuild
  } = releaseFile.value;
  const release = finalizeReleaseManifest({
    build: releaseBuild as unknown as ReturnType<typeof buildBuildManifest>,
    imageId: string(imageId, "release image ID"),
    imageTag: string(imageTag, "release image tag"),
  });
  if (canonicalJson(release) !== releaseFile.bytes.toString("utf8")) {
    throw new Error("release manifest bytes do not match canonical release fields");
  }
  equal(buildManifestSha256, release.buildManifestSha256, "build manifest digest");
  equal(sha256Hex(buildFile.bytes), release.buildManifestSha256, "installed build manifest digest");
  equal(canonicalJson(build), canonicalJson(releaseBuild), "build and release manifest");

  const signature = targetFile.value.signature as Record<string, unknown> | undefined;
  if (
    targetFile.value.schemaVersion !== 1
    || signature?.algorithm !== "Ed25519"
  ) {
    throw new Error("target descriptor signature metadata is invalid");
  }
  const signedDescriptor = assembleSignedDeploymentTargetDescriptor(
    targetFile.value.descriptor as DeploymentTargetDescriptorInput,
    {
      keyId: string(signature.keyId, "target descriptor key ID"),
      value: string(signature.value, "target descriptor signature"),
    },
  );
  equal(
    targetFile.value.descriptorSha256,
    signedDescriptor.descriptorSha256,
    "target descriptor canonical digest",
  );
  if (canonicalJson(signedDescriptor) !== targetFile.bytes.toString("utf8")) {
    throw new Error("target descriptor artifact bytes are not canonical");
  }
  const targetDescriptorSha256 = deploymentTargetDescriptorArtifactSha256(signedDescriptor);
  const descriptor = signedDescriptor.descriptor;
  const context = contextFile.value;
  const releaseManifestSha256 = sha256Hex(releaseFile.bytes);
  if (!SHA256.test(targetDescriptorSha256) || !SHA256.test(releaseManifestSha256)) {
    throw new Error("runtime release digest is invalid");
  }

  equal(descriptor.releaseManifestSha256, releaseManifestSha256, "target descriptor release manifest");
  equal(descriptor.operatorBundleSha256, release.operatorBundleSha256, "target descriptor operator bundle");
  equal(descriptor.releaseSourceSha, release.sourceSha, "target descriptor source SHA");
  equal(descriptor.imageId, release.imageId, "target descriptor image ID");
  equal(descriptor.imageTag, release.imageTag, "target descriptor image tag");
  equal(descriptor.releaseEnvironment, descriptor.runtimeEnvironment, "target descriptor environment");
  equal(
    descriptor.composeProject,
    descriptor.runtimeEnvironment === "production" ? "spx-production" : "spx-staging",
    "target descriptor compose project",
  );

  equal(context.target, descriptor.runtimeEnvironment, "deployment context environment");
  equal(context.sourceSha, release.sourceSha, "deployment context source SHA");
  equal(context.imageId, release.imageId, "deployment context image ID");
  equal(context.imageTag, release.imageTag, "deployment context image tag");
  equal(context.topology, descriptor.topology, "deployment context topology");
  equal(context.composeProject, descriptor.composeProject, "deployment context compose project");
  equal(context.releaseManifestSha256, releaseManifestSha256, "deployment context release manifest");
  equal(context.operatorBundleSha256, release.operatorBundleSha256, "deployment context operator bundle");
  equal(context.descriptorArtifactSha256, targetDescriptorSha256, "deployment context target descriptor");

  return freeze({
    version: release.version,
    gitSha: release.sourceSha,
    buildId: release.buildId,
    environment: descriptor.runtimeEnvironment,
    topology: descriptor.topology,
    imageId: release.imageId,
    imageTag: release.imageTag,
    targetDescriptorSha256,
    operatorBundleSha256: release.operatorBundleSha256,
  });
}

export function runtimeNodeRegistration(
  identity: RuntimeReleaseIdentity,
  startedAt = new Date().toISOString(),
): RuntimeNodeReleaseRegistration {
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("runtime identity start time is invalid");
  const { version, ...metadata } = identity;
  return {
    version,
    metadata: {
      ...metadata,
      startedAt,
    },
  };
}
