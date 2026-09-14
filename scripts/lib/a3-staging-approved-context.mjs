import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  readEvidenceBundle,
  readEvidenceBytes,
  readEvidenceJson,
} from "./evidence-artifact.mjs";
import {
  installVerifiedReleaseBinding,
  loadInstalledReleaseBinding,
} from "./staging-installed-context.mjs";
import {
  openVerifiedStagingRollout,
  verifyStagingRolloutEnvelope,
} from "../staging-rollout-approval-verify.mjs";

export const APPROVED_STAGING_ROOT = "/var/lib/spx-staging-rollout/approved";

const FIXED_FILES = Object.freeze({
  envelope: "approval-envelope.json",
  releaseManifest: "release-manifest.json",
  rollbackReleaseManifest: "rollback-release-manifest.json",
  targetDescriptor: "target-descriptor.json",
  operatorBundleIndex: "operator-bundle-index.json",
  operatorBundle: "operator-bundle.tar",
  approvalAttestation: "approval-attestation.json",
  targetDescriptorAttestation: "target-descriptor-attestation.json",
  actionIndex: "action-index.json",
  actionIndexAttestation: "action-index-attestation.json",
});

function fixedPath(name) {
  return join(APPROVED_STAGING_ROOT, FIXED_FILES[name]);
}

function actionAttestationFilename(filename) {
  return `${filename}.attestation.json`;
}

function actionBundleNames(index) {
  if (!index || !Array.isArray(index.actions) || index.actions.length === 0) {
    throw new Error("installed staging action index is invalid");
  }
  const names = [];
  const seen = new Set();
  for (const entry of index.actions) {
    const expected = `${String(entry?.sequence).padStart(3, "0")}-${entry?.actionId}.action.json`;
    if (
      !Number.isSafeInteger(entry?.sequence) ||
      entry.sequence < 1 ||
      typeof entry?.actionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.actionId) ||
      entry?.filename !== expected ||
      seen.has(entry.filename)
    ) {
      throw new Error("installed staging action index entry is invalid");
    }
    seen.add(entry.filename);
    names.push(entry.filename, actionAttestationFilename(entry.filename));
  }
  return names;
}

async function assertSecureDirectory(path) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("installed staging approval root is invalid");
  }
  if (process.platform !== "win32") {
    if (Number(stat.uid) !== 0 || (Number(stat.mode & 0o777n) & 0o077) !== 0) {
      throw new Error("installed staging approval root is not root-private");
    }
  }
}

export function assertInstalledBindingMatchesVerified(binding, verified) {
  const expected = {
    candidateSha: verified.candidateSha,
    imageDigest: verified.imageDigest,
    releaseManifestSha256: verified.releaseManifestSha256,
    environment: verified.environment,
    topology: verified.topology,
    composeProject: verified.composeProject,
    stagingTargetDescriptorSha256: verified.targetDescriptorSha256,
    operatorBundleSha256: verified.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: verified.envelopeSha256,
    stagingRunId: verified.stagingRunId,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (binding?.[field] !== value) {
      throw new Error(`installed staging binding ${field} changed`);
    }
  }
  return true;
}

export async function loadApprovedStagingArtifacts() {
  await assertSecureDirectory(APPROVED_STAGING_ROOT);
  const envelope = await readEvidenceJson(fixedPath("envelope"), { requireCanonical: true });
  const releaseManifest = await readEvidenceJson(fixedPath("releaseManifest"), {
    requireCanonical: true,
  });
  const rollbackReleaseManifest = await readEvidenceJson(
    fixedPath("rollbackReleaseManifest"),
    { requireCanonical: true },
  );
  const targetDescriptor = await readEvidenceJson(fixedPath("targetDescriptor"), {
    requireCanonical: true,
  });
  const operatorBundleIndex = await readEvidenceJson(fixedPath("operatorBundleIndex"), {
    requireCanonical: true,
  });
  const operatorBundle = await readEvidenceBytes(fixedPath("operatorBundle"), {
    maxFileBytes: 64 * 1024 * 1024,
  });
  const approvalAttestation = await readEvidenceJson(fixedPath("approvalAttestation"), {
    requireCanonical: true,
  });
  const targetDescriptorAttestation = await readEvidenceJson(
    fixedPath("targetDescriptorAttestation"),
    { requireCanonical: true },
  );
  const actionIndex = await readEvidenceJson(fixedPath("actionIndex"), {
    requireCanonical: true,
  });
  const actionIndexAttestation = await readEvidenceJson(fixedPath("actionIndexAttestation"), {
    requireCanonical: true,
  });
  const names = actionBundleNames(actionIndex);
  const actionBundle = await readEvidenceBundle(join(APPROVED_STAGING_ROOT, "actions"), {
    allowedNames: names,
    maxTotalBytes: 2 * 1024 * 1024,
  });
  const actionArtifacts = {};
  const actionAttestations = {};
  for (const entry of actionIndex.actions) {
    actionArtifacts[entry.filename] = actionBundle[entry.filename];
    actionAttestations[entry.filename] = actionBundle[actionAttestationFilename(entry.filename)];
  }
  return {
    envelope,
    artifacts: {
      releaseManifest,
      rollbackReleaseManifest,
      targetDescriptor,
      operatorBundleIndex,
      operatorBundle,
      approvalAttestation,
      targetDescriptorAttestation,
      actionIndex,
      actionIndexAttestation,
      actionArtifacts,
      actionAttestations,
    },
  };
}

function bindingValue(verified, actionJournalHeadSha256) {
  return {
    candidateSha: verified.candidateSha,
    imageDigest: verified.imageDigest,
    releaseManifestSha256: verified.releaseManifestSha256,
    environment: verified.environment,
    topology: verified.topology,
    composeProject: verified.composeProject,
    stagingTargetDescriptorSha256: verified.targetDescriptorSha256,
    operatorBundleSha256: verified.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: verified.envelopeSha256,
    actionJournalHeadSha256,
    stagingRunId: verified.stagingRunId,
  };
}

export async function openInstalledVerifiedStagingRollout(...callerArguments) {
  let ports = null;
  if (callerArguments.length > 0) {
    if (
      process.env.NODE_ENV !== "test" ||
      callerArguments.length !== 1 ||
      !callerArguments[0] ||
      typeof callerArguments[0] !== "object" ||
      Array.isArray(callerArguments[0])
    ) {
      throw new Error("caller-selected installed staging rollout ports are forbidden");
    }
    ports = callerArguments[0];
    const allowedPortNames = new Set(["loadContext", "openRollout", "installBinding"]);
    if (
      Object.keys(ports).some((name) => !allowedPortNames.has(name)) ||
      typeof ports.loadContext !== "function" ||
      typeof ports.openRollout !== "function" ||
      (ports.installBinding !== undefined && typeof ports.installBinding !== "function")
    ) {
      throw new Error("test-only installed staging rollout ports are invalid");
    }
  }
  const loadContext = ports?.loadContext ?? loadInstalledApprovedStagingContext;
  const openRollout = ports?.openRollout ?? openVerifiedStagingRollout;
  const installBinding = ports?.installBinding ?? installVerifiedReleaseBinding;
  const context = await loadContext();
  const { installedBinding, envelope, artifacts, verified } = context;
  const rollout = await openRollout({
    envelope,
    artifacts,
    ledgerOptions: { persistReleaseBinding: false },
  });
  const currentHead = await rollout.head();
  if (currentHead !== installedBinding.actionJournalHeadSha256) {
    await rollout.close();
    throw new Error("installed staging action journal head changed");
  }

  let closed = false;
  return Object.freeze({
    binding: installedBinding,
    verified,
    descriptor: artifacts.targetDescriptor.descriptor,
    action(actionId) {
      if (closed) throw new Error("installed staging rollout is closed");
      const inherited = rollout.action(actionId);
      let used = false;
      return Object.freeze({
        async run() {
          if (used) throw new Error("installed staging action cannot be reused");
          used = true;
          try {
            return await inherited.run();
          } finally {
            await installBinding(
              bindingValue(verified, await rollout.head()),
            );
          }
        },
      });
    },
    async snapshot(...callerArguments) {
      if (closed) throw new Error("installed staging rollout is closed");
      if (callerArguments.length > 0) {
        throw new Error("installed staging rollout snapshot accepts zero arguments");
      }
      return rollout.snapshot();
    },
    async close() {
      if (closed) return;
      closed = true;
      await rollout.close();
    },
  });
}

export async function loadInstalledApprovedStagingContext() {
  const installedBinding = await loadInstalledReleaseBinding({ environment: "staging" });
  const { envelope, artifacts } = await loadApprovedStagingArtifacts();
  const verified = await verifyStagingRolloutEnvelope(envelope, artifacts);
  assertInstalledBindingMatchesVerified(installedBinding, verified);
  return Object.freeze({
    installedBinding,
    envelope,
    artifacts,
    verified,
    descriptor: artifacts.targetDescriptor.descriptor,
  });
}
