#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  readEvidenceBundle,
  validateReleaseBinding,
} from "./lib/evidence-artifact.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";

const DIRECTORY = "/var/lib/spx-production-rollout/evidence/db-transition";
const EVIDENCE_FILE = "db-transition-evidence.json";
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_AGE_MS = 30 * 60 * 1000;

export const PRODUCTION_DB_TRANSITION_SERVICES = Object.freeze([
  "realtime-service",
  "line-service",
  "notification-service",
  "worker-ifn-split",
  "worker-ptwl-split",
  "web-api",
  "phase3-control",
]);

function exactObject(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function epoch(value) {
  if (typeof value !== "string") return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}

function hash(value) {
  return typeof value === "string" && SHA256.test(value);
}

export function parseProductionDbTransitionArgs(argv) {
  if (
    !Array.isArray(argv)
    || argv.length !== 2
    || argv[0] !== "--supervised-production"
    || argv[1] !== `--dir=${DIRECTORY}`
  ) throw new Error("DB-transition evidence must use supervised production and the fixed approved path");
  return { directory: DIRECTORY, supervisedProduction: true };
}

export function evaluateProductionDbTransitionEvidence(value, expectedRelease, options = {}) {
  const failures = [];
  if (!exactObject(value, [
    "schemaVersion", "gate6Id", "releaseEnvironment", "runtimeEnvironment",
    "drillMode", "composeProject", "release", "checkedAt", "services",
    "migrator", "liveness",
  ])) failures.push("EVIDENCE_SHAPE_INVALID");
  if (
    value?.schemaVersion !== 1
    || !ID.test(value?.gate6Id ?? "")
    || value?.releaseEnvironment !== "production"
    || value?.runtimeEnvironment !== "production"
    || value?.drillMode !== "supervised-production"
    || value?.composeProject !== "spx-production"
  ) failures.push("PRODUCTION_IDENTITY_INVALID");
  try {
    validateReleaseBinding(value?.release, expectedRelease);
  } catch {
    failures.push("RELEASE_BINDING_INVALID");
  }
  const checkedAt = epoch(value?.checkedAt);
  const nowMs = options.now?.getTime?.() ?? Date.now();
  if (
    !Number.isFinite(checkedAt)
    || checkedAt > nowMs + 5_000
    || nowMs - checkedAt > MAX_EVIDENCE_AGE_MS
  ) failures.push("EVIDENCE_TIME_INVALID");

  const expectedServices = [...PRODUCTION_DB_TRANSITION_SERVICES].sort();
  const actualServices = Array.isArray(value?.services)
    ? value.services.map((service) => service?.service).sort()
    : [];
  if (canonicalJson(actualServices) !== canonicalJson(expectedServices)) failures.push("SERVICE_SET_INVALID");
  const seen = new Set();
  for (const service of Array.isArray(value?.services) ? value.services : []) {
    if (
      !exactObject(service, [
        "service", "principalSha256", "positiveGrantProofSha256",
        "forbiddenGrantProofSha256", "runtimeCapabilitySha256",
        "runtimeIdentitySha256", "principalPrepared", "switched", "ready",
        "legacyPrincipalValid", "checkedAt",
      ])
      || !PRODUCTION_DB_TRANSITION_SERVICES.includes(service?.service)
      || seen.has(service?.service)
      || ![
        service?.principalSha256,
        service?.positiveGrantProofSha256,
        service?.forbiddenGrantProofSha256,
        service?.runtimeCapabilitySha256,
        service?.runtimeIdentitySha256,
      ].every(hash)
      || service?.principalPrepared !== true
      || service?.switched !== true
      || service?.ready !== true
      || service?.legacyPrincipalValid !== true
      || !Number.isFinite(epoch(service?.checkedAt))
      || epoch(service?.checkedAt) > checkedAt
      || checkedAt - epoch(service?.checkedAt) > MAX_EVIDENCE_AGE_MS
    ) failures.push("SERVICE_TRANSITION_INVALID");
    seen.add(service?.service);
  }
  if (
    !exactObject(value?.migrator, ["verificationSha256", "runtimePrincipalMounted", "checkedAt"])
    || !hash(value?.migrator?.verificationSha256)
    || value?.migrator?.runtimePrincipalMounted !== false
    || !Number.isFinite(epoch(value?.migrator?.checkedAt))
    || epoch(value?.migrator?.checkedAt) > checkedAt
  ) failures.push("MIGRATOR_ISOLATION_INVALID");
  if (
    !exactObject(value?.liveness, [
      "monitorStatus", "monitorLeaseExpiresAt", "supervisorStatus",
      "supervisorLeaseExpiresAt", "continuousObservationSeconds", "redSamples",
    ])
    || value?.liveness?.monitorStatus !== "green"
    || value?.liveness?.supervisorStatus !== "green"
    || epoch(value?.liveness?.monitorLeaseExpiresAt) <= checkedAt
    || epoch(value?.liveness?.supervisorLeaseExpiresAt) <= checkedAt
    || !Number.isSafeInteger(value?.liveness?.continuousObservationSeconds)
    || value.liveness.continuousObservationSeconds < 1_800
    || value?.liveness?.redSamples !== 0
  ) failures.push("LIVENESS_INVALID");
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

async function main() {
  try {
    const args = parseProductionDbTransitionArgs(process.argv.slice(2));
    const expectedRelease = await loadInstalledReleaseBinding({ environment: "supervised-production" });
    const bundle = await readEvidenceBundle(args.directory, {
      allowedNames: [EVIDENCE_FILE],
      requireAll: true,
      maxFileBytes: 512 * 1024,
      maxTotalBytes: 512 * 1024,
    });
    const evidence = bundle[EVIDENCE_FILE];
    const result = evaluateProductionDbTransitionEvidence(evidence, expectedRelease);
    const output = {
      ...result,
      evidenceSha256: createHash("sha256").update(canonicalJson(evidence)).digest("hex"),
    };
    process.stdout.write(`${canonicalJson(output)}\n`);
    if (!output.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${canonicalJson({ ok: false, failures: ["DB_TRANSITION_EVIDENCE_INVALID"] })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
