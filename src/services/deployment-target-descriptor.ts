import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyLike,
  type PrivateKeyInput,
} from "node:crypto";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_TAG = /^spx-app:[0-9a-f]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const DATABASE_ROLE = /^[a-z][a-z0-9-]{1,63}$/;
const DATABASE_ACCOUNT_HOST = /^(?!.*[%_])[0-9A-Za-z.:-]+(?:\/[0-9A-Za-z.:-]+)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNER_WORKFLOW = ".github/workflows/deployment-target-descriptor-signer.yml";

export const STAGING_DEPLOYMENT_TARGET_DB_ROLES: readonly string[] = Object.freeze([
  "auto-accept-ifn-phase3",
  "auto-accept-ptwl-phase3",
  "gate6-monitor",
  "line-service",
  "migrator",
  "notification-service",
  "phase3-control",
  "phase3-observer",
  "poller-ifn-phase3",
  "poller-ptwl-phase3",
  "realtime-service",
  "web-api",
  "worker-ifn",
  "worker-ifn-split",
  "worker-ptwl",
  "worker-ptwl-split",
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new Error("descriptor contains a non-canonical number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("descriptor contains a cycle");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (seen.has(value)) throw new Error("descriptor contains a cycle");
    seen.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (
        item === undefined ||
        typeof item === "bigint" ||
        typeof item === "function" ||
        typeof item === "symbol"
      ) {
        throw new Error("descriptor contains a non-JSON value");
      }
      result[key] = canonicalize(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error("descriptor contains a non-JSON value");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type ReleaseEnvironment = "staging" | "production";
export type DeploymentTopology = "legacy" | "split";

export interface DeploymentTargetDescriptorInput {
  schemaVersion: 1;
  descriptorId: string;
  releaseEnvironment: ReleaseEnvironment;
  runtimeEnvironment: ReleaseEnvironment;
  composeProject: "spx-staging" | "spx-production";
  topology: DeploymentTopology;
  releaseManifestSha256: string;
  operatorBundleSha256: string;
  releaseSourceSha: string;
  imageId: string;
  imageTag: string;
  targetFactsSha256: string;
  target: {
    hostIdentitySha256: string;
    networkIdentitySha256: string;
    approvedSourceCidrsSha256: string;
    dockerContext: "unix:///var/run/docker.sock";
    productionObserverPolicySha256: string | null;
    canonicalPaths: {
      releaseRoot: string;
      environmentFile: string;
      stateRoot: string;
    };
  };
  database: {
    name: "spx_staging" | "spx";
    tlsFingerprintSha256: string;
    accountHosts: Record<string, string>;
  };
  providerTargetFingerprints: string[];
  publishedPorts: number[];
  volumeFingerprints: string[];
  nodeIds: string[];
  productionDenyTargetSha256: string;
  issuedAt: string;
  expiresAt: string;
  signingWorkflowSourceSha: string;
  signingWorkflowFileSha256: string;
  signing: {
    repository: string;
    workflowRef: string;
    environment: ReleaseEnvironment;
    subject: string;
    audience: string;
    issuer: "https://token.actions.githubusercontent.com";
    jobWorkflowRef: string;
    jobWorkflowSha: string;
  };
}

export type DeploymentTargetDescriptor = Readonly<DeploymentTargetDescriptorInput>;

export interface SignedDeploymentTargetDescriptor {
  schemaVersion: 1;
  descriptor: DeploymentTargetDescriptor;
  descriptorSha256: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  };
}

export interface DeploymentTargetAttestation {
  schemaVersion: 1;
  artifactSha256: string;
  repository: string;
  workflowRef: string;
  environment: ReleaseEnvironment;
  subject: string;
  audience: string;
  issuer: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
  signingWorkflowSourceSha: string;
  signingWorkflowFileSha256: string;
  issuedAt: string;
}

export interface DeploymentTargetTrust {
  keyId: string;
  publicKey: KeyLike;
  repository: string;
  workflowRef: string;
  environment: ReleaseEnvironment;
  subject: string;
  audience: string;
  issuer: string;
  jobWorkflowRef: string;
  signingWorkflowSourceSha: string;
  signingWorkflowFileSha256: string;
  releaseManifestSha256: string;
  operatorBundleSha256: string;
  releaseSourceSha: string;
  imageId: string;
  imageTag: string;
  targetFactsSha256: string;
  now: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`${label} must be a plain object`);
  return value;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value)
    .filter((key) => !expected.has(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0)
    throw new Error(`${label} is missing required field(s): ${missing.join(", ")}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be SHA-256`);
  return result;
}

function sha40(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA40.test(result)) throw new Error(`${label} must be a 40-character lowercase hex SHA`);
  return result;
}

function isoInstant(value: unknown, label: string): string {
  const result = string(value, label);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result)
    throw new Error(`${label} must be a canonical ISO timestamp`);
  return result;
}

function uniqueSortedStrings(value: unknown, label: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  const result = value.map((item, index) => {
    const candidate = string(item, `${label}[${index}]`);
    if (!pattern.test(candidate)) throw new Error(`${label}[${index}] is invalid`);
    return candidate;
  });
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`);
  return result.sort();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateAbsolutePath(value: unknown, expected: string, label: string): string {
  const candidate = string(value, label);
  if (
    candidate !== expected ||
    !candidate.startsWith("/") ||
    candidate.includes("..") ||
    candidate.includes("\\")
  ) {
    throw new Error(`${label} must equal the protected canonical path`);
  }
  return candidate;
}

function normalizedDatabaseAccountHosts(
  value: unknown,
  environment?: ReleaseEnvironment,
): Record<string, string> {
  const raw = record(value, "database.accountHosts");
  const entries = Object.entries(raw).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("database.accountHosts must contain between 1 and 64 roles");
  }
  const normalized: Record<string, string> = {};
  for (const [role, host] of entries) {
    if (
      !DATABASE_ROLE.test(role) ||
      typeof host !== "string" ||
      host.length < 1 ||
      host.length > 255 ||
      host !== host.trim() ||
      !DATABASE_ACCOUNT_HOST.test(host)
    ) {
      throw new Error("database.accountHosts contains an invalid exact role/host binding");
    }
    normalized[role] = host;
  }
  if (
    environment === "staging" &&
    (entries.length !== STAGING_DEPLOYMENT_TARGET_DB_ROLES.length ||
      entries.some(([role], index) => role !== STAGING_DEPLOYMENT_TARGET_DB_ROLES[index]))
  ) {
    throw new Error(
      "database.accountHosts must equal the exact staging provisioned database role set",
    );
  }
  return normalized;
}

function normalizedProductionObserverPolicySha256(
  value: unknown,
  environment: ReleaseEnvironment,
): string | null {
  if (environment === "production") {
    if (value !== null)
      throw new Error("target.productionObserverPolicySha256 must be null in production");
    return null;
  }
  return sha256(value, "target.productionObserverPolicySha256");
}

function targetFactsProjection(input: Record<string, unknown>): Record<string, unknown> {
  const releaseEnvironment = string(input.releaseEnvironment, "releaseEnvironment");
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production")
    throw new Error("releaseEnvironment is invalid");
  const runtimeEnvironment = string(input.runtimeEnvironment, "runtimeEnvironment");
  if (runtimeEnvironment !== releaseEnvironment)
    throw new Error("runtimeEnvironment must equal releaseEnvironment");
  const composeProject = string(input.composeProject, "composeProject");
  const expectedProject = releaseEnvironment === "staging" ? "spx-staging" : "spx-production";
  if (composeProject !== expectedProject)
    throw new Error(`composeProject must equal ${expectedProject}`);
  const topology = string(input.topology, "topology");
  if (topology !== "legacy" && topology !== "split")
    throw new Error("topology must be legacy or split");
  const target = record(input.target, "target facts target");
  exact(
    target,
    [
      "hostIdentitySha256",
      "networkIdentitySha256",
      "approvedSourceCidrsSha256",
      "dockerContext",
      "productionObserverPolicySha256",
      "canonicalPaths",
    ],
    "target facts target",
  );
  if (target.dockerContext !== "unix:///var/run/docker.sock")
    throw new Error("target.dockerContext must be the local protected Docker socket");
  const paths = record(target.canonicalPaths, "target facts canonical paths");
  exact(
    paths,
    ["releaseRoot", "environmentFile", "stateRoot"],
    "target facts canonical paths",
  );
  const pathPrefix = releaseEnvironment === "staging" ? "spx-staging" : "spx-production";
  const database = record(input.database, "target facts database");
  exact(database, ["accountHosts", "name", "tlsFingerprintSha256"], "target facts database");
  const expectedDatabase = releaseEnvironment === "staging" ? "spx_staging" : "spx";
  if (database.name !== expectedDatabase)
    throw new Error(`database.name must equal ${expectedDatabase}`);
  if (!Array.isArray(input.publishedPorts) || input.publishedPorts.length === 0)
    throw new Error("publishedPorts must be a non-empty array");
  const ports = input.publishedPorts.map((port, index) => {
    if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error(`publishedPorts[${index}] is invalid`);
    return Number(port);
  });
  if (new Set(ports).size !== ports.length)
    throw new Error("publishedPorts must not contain duplicates");
  ports.sort((left, right) => left - right);
  return {
    releaseEnvironment,
    runtimeEnvironment,
    composeProject,
    topology,
    target: {
      hostIdentitySha256: sha256(target.hostIdentitySha256, "target.hostIdentitySha256"),
      networkIdentitySha256: sha256(
        target.networkIdentitySha256,
        "target.networkIdentitySha256",
      ),
      approvedSourceCidrsSha256: sha256(
        target.approvedSourceCidrsSha256,
        "target.approvedSourceCidrsSha256",
      ),
      dockerContext: "unix:///var/run/docker.sock",
      productionObserverPolicySha256: normalizedProductionObserverPolicySha256(
        target.productionObserverPolicySha256,
        releaseEnvironment,
      ),
      canonicalPaths: {
        releaseRoot: validateAbsolutePath(
          paths.releaseRoot,
          `/opt/${pathPrefix}/release`,
          "target.canonicalPaths.releaseRoot",
        ),
        environmentFile: validateAbsolutePath(
          paths.environmentFile,
          `/etc/${pathPrefix}/runtime.env`,
          "target.canonicalPaths.environmentFile",
        ),
        stateRoot: validateAbsolutePath(
          paths.stateRoot,
          `/var/lib/${pathPrefix}-rollout`,
          "target.canonicalPaths.stateRoot",
        ),
      },
    },
    database: {
      name: expectedDatabase,
      tlsFingerprintSha256: sha256(
        database.tlsFingerprintSha256,
        "database.tlsFingerprintSha256",
      ),
      accountHosts: normalizedDatabaseAccountHosts(database.accountHosts, releaseEnvironment),
    },
    providerTargetFingerprints: uniqueSortedStrings(
      input.providerTargetFingerprints,
      "providerTargetFingerprints",
      SHA256,
    ),
    publishedPorts: ports,
    volumeFingerprints: uniqueSortedStrings(input.volumeFingerprints, "volumeFingerprints", SHA256),
    nodeIds: uniqueSortedStrings(input.nodeIds, "nodeIds", NODE_ID),
    productionDenyTargetSha256: sha256(
      input.productionDenyTargetSha256,
      "productionDenyTargetSha256",
    ),
  };
}

export function validateDeploymentTargetFacts(
  input: Record<string, unknown>,
  expectedEnvironment: ReleaseEnvironment,
): true {
  if (expectedEnvironment !== "staging" && expectedEnvironment !== "production")
    throw new Error("protected target facts expected environment is invalid");
  const facts = record(input, "protected target facts");
  exact(
    facts,
    [
      "releaseEnvironment",
      "runtimeEnvironment",
      "composeProject",
      "topology",
      "target",
      "database",
      "providerTargetFingerprints",
      "publishedPorts",
      "volumeFingerprints",
      "nodeIds",
      "productionDenyTargetSha256",
      "signing",
    ],
    "protected target facts",
  );
  if (facts.releaseEnvironment !== expectedEnvironment)
    throw new Error("protected target facts environment does not match the requested environment");
  targetFactsProjection(facts);
  const signing = record(facts.signing, "protected target signing facts");
  exact(
    signing,
    ["repository", "environment", "subject", "audience", "issuer"],
    "protected target signing facts",
  );
  const repository = string(signing.repository, "protected target signing repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("protected target signing repository is invalid");
  if (signing.environment !== expectedEnvironment)
    throw new Error("protected target signing environment does not match the requested environment");
  if (signing.subject !== `repo:${repository}:environment:${expectedEnvironment}`)
    throw new Error("protected target signing subject is invalid");
  const audience = string(signing.audience, "protected target signing audience");
  if (!audience.startsWith("https://"))
    throw new Error("protected target signing audience must be HTTPS");
  if (signing.issuer !== "https://token.actions.githubusercontent.com")
    throw new Error("protected target signing issuer is invalid");
  return true;
}

export function deploymentTargetFactsSha256(input: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(targetFactsProjection(input)));
}

export function buildDeploymentTargetDescriptor(
  input: DeploymentTargetDescriptorInput,
): DeploymentTargetDescriptor {
  const raw = record(input, "deployment target descriptor");
  exact(
    raw,
    [
      "schemaVersion",
      "descriptorId",
      "releaseEnvironment",
      "runtimeEnvironment",
      "composeProject",
      "topology",
      "releaseManifestSha256",
      "operatorBundleSha256",
      "releaseSourceSha",
      "imageId",
      "imageTag",
      "targetFactsSha256",
      "target",
      "database",
      "providerTargetFingerprints",
      "publishedPorts",
      "volumeFingerprints",
      "nodeIds",
      "productionDenyTargetSha256",
      "issuedAt",
      "expiresAt",
      "signingWorkflowSourceSha",
      "signingWorkflowFileSha256",
      "signing",
    ],
    "deployment target descriptor",
  );
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  const descriptorId = string(raw.descriptorId, "descriptorId");
  if (!SAFE_ID.test(descriptorId)) throw new Error("descriptorId is invalid");
  const releaseEnvironment = string(raw.releaseEnvironment, "releaseEnvironment");
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production")
    throw new Error("releaseEnvironment is invalid");
  const runtimeEnvironment = string(raw.runtimeEnvironment, "runtimeEnvironment");
  if (runtimeEnvironment !== releaseEnvironment)
    throw new Error("runtimeEnvironment must equal releaseEnvironment");
  const expectedProject = releaseEnvironment === "staging" ? "spx-staging" : "spx-production";
  const composeProject = string(raw.composeProject, "composeProject");
  if (composeProject !== expectedProject)
    throw new Error(`composeProject must equal ${expectedProject}`);
  const topology = string(raw.topology, "topology");
  if (topology !== "legacy" && topology !== "split")
    throw new Error("topology must be legacy or split");
  const releaseManifestSha256 = sha256(raw.releaseManifestSha256, "releaseManifestSha256");
  const operatorBundleSha256 = sha256(raw.operatorBundleSha256, "operatorBundleSha256");
  const releaseSourceSha = sha40(raw.releaseSourceSha, "releaseSourceSha");
  const imageId = string(raw.imageId, "imageId");
  const imageTag = string(raw.imageTag, "imageTag");
  if (!IMAGE_ID.test(imageId)) throw new Error("imageId must be an immutable sha256 image ID");
  if (!IMAGE_TAG.test(imageTag) || imageTag !== `spx-app:${releaseSourceSha}`)
    throw new Error("imageTag must bind the exact release source SHA");

  const target = record(raw.target, "target");
  exact(
    target,
    [
      "hostIdentitySha256",
      "networkIdentitySha256",
      "approvedSourceCidrsSha256",
      "dockerContext",
      "productionObserverPolicySha256",
      "canonicalPaths",
    ],
    "target",
  );
  if (target.dockerContext !== "unix:///var/run/docker.sock")
    throw new Error("target.dockerContext must be the local protected Docker socket");
  const paths = record(target.canonicalPaths, "target.canonicalPaths");
  exact(paths, ["releaseRoot", "environmentFile", "stateRoot"], "target.canonicalPaths");
  const pathPrefix = releaseEnvironment === "staging" ? "spx-staging" : "spx-production";
  const canonicalPaths = {
    releaseRoot: validateAbsolutePath(
      paths.releaseRoot,
      `/opt/${pathPrefix}/release`,
      "target.canonicalPaths.releaseRoot",
    ),
    environmentFile: validateAbsolutePath(
      paths.environmentFile,
      `/etc/${pathPrefix}/runtime.env`,
      "target.canonicalPaths.environmentFile",
    ),
    stateRoot: validateAbsolutePath(
      paths.stateRoot,
      `/var/lib/${pathPrefix}-rollout`,
      "target.canonicalPaths.stateRoot",
    ),
  };

  const database = record(raw.database, "database");
  exact(database, ["accountHosts", "name", "tlsFingerprintSha256"], "database");
  const expectedDatabase = releaseEnvironment === "staging" ? "spx_staging" : "spx";
  if (database.name !== expectedDatabase)
    throw new Error(`database.name must equal ${expectedDatabase}`);
  const providerTargetFingerprints = uniqueSortedStrings(
    raw.providerTargetFingerprints,
    "providerTargetFingerprints",
    SHA256,
  );
  const volumeFingerprints = uniqueSortedStrings(
    raw.volumeFingerprints,
    "volumeFingerprints",
    SHA256,
  );
  const nodeIds = uniqueSortedStrings(raw.nodeIds, "nodeIds", NODE_ID);
  if (!Array.isArray(raw.publishedPorts) || raw.publishedPorts.length === 0)
    throw new Error("publishedPorts must be a non-empty array");
  const publishedPorts = raw.publishedPorts.map((port, index) => {
    if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error(`publishedPorts[${index}] is invalid`);
    return Number(port);
  });
  if (new Set(publishedPorts).size !== publishedPorts.length)
    throw new Error("publishedPorts must not contain duplicates");
  publishedPorts.sort((left, right) => left - right);

  const issuedAt = isoInstant(raw.issuedAt, "issuedAt");
  const expiresAt = isoInstant(raw.expiresAt, "expiresAt");
  const validityMs = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (validityMs <= 0 || validityMs > 60 * 60 * 1000)
    throw new Error("descriptor validity window must be positive and at most one hour");
  const signingWorkflowSourceSha = sha40(raw.signingWorkflowSourceSha, "signingWorkflowSourceSha");
  const signingWorkflowFileSha256 = sha256(
    raw.signingWorkflowFileSha256,
    "signingWorkflowFileSha256",
  );
  const signing = record(raw.signing, "signing");
  exact(
    signing,
    [
      "repository",
      "workflowRef",
      "environment",
      "subject",
      "audience",
      "issuer",
      "jobWorkflowRef",
      "jobWorkflowSha",
    ],
    "signing",
  );
  const repository = string(signing.repository, "signing.repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("signing.repository is invalid");
  const exactWorkflowRef = `${repository}/${SIGNER_WORKFLOW}@${signingWorkflowSourceSha}`;
  const workflowRef = string(signing.workflowRef, "signing.workflowRef");
  const jobWorkflowRef = string(signing.jobWorkflowRef, "signing.jobWorkflowRef");
  if (workflowRef !== exactWorkflowRef || jobWorkflowRef !== exactWorkflowRef) {
    throw new Error("signing workflow refs must end in the exact source SHA");
  }
  if (signing.environment !== releaseEnvironment)
    throw new Error("signing.environment must equal releaseEnvironment");
  const expectedSubject = `repo:${repository}:environment:${releaseEnvironment}`;
  if (signing.subject !== expectedSubject)
    throw new Error("signing.subject does not match the protected environment");
  const audience = string(signing.audience, "signing.audience");
  if (!audience.startsWith("https://")) throw new Error("signing.audience must be HTTPS");
  if (signing.issuer !== "https://token.actions.githubusercontent.com")
    throw new Error("signing.issuer is invalid");
  const jobWorkflowSha = sha40(signing.jobWorkflowSha, "signing.jobWorkflowSha");
  if (jobWorkflowSha !== signingWorkflowSourceSha)
    throw new Error("signing.jobWorkflowSha must equal signingWorkflowSourceSha");

  const normalizedTargetFacts = {
    releaseEnvironment,
    runtimeEnvironment: releaseEnvironment,
    composeProject: expectedProject,
    topology,
    target: {
      hostIdentitySha256: sha256(target.hostIdentitySha256, "target.hostIdentitySha256"),
      networkIdentitySha256: sha256(target.networkIdentitySha256, "target.networkIdentitySha256"),
      approvedSourceCidrsSha256: sha256(
        target.approvedSourceCidrsSha256,
        "target.approvedSourceCidrsSha256",
      ),
      dockerContext: "unix:///var/run/docker.sock",
      productionObserverPolicySha256: normalizedProductionObserverPolicySha256(
        target.productionObserverPolicySha256,
        releaseEnvironment,
      ),
      canonicalPaths,
    },
    database: {
      name: expectedDatabase,
      tlsFingerprintSha256: sha256(database.tlsFingerprintSha256, "database.tlsFingerprintSha256"),
      accountHosts: normalizedDatabaseAccountHosts(database.accountHosts, releaseEnvironment),
    },
    providerTargetFingerprints,
    publishedPorts,
    volumeFingerprints,
    nodeIds,
    productionDenyTargetSha256: sha256(
      raw.productionDenyTargetSha256,
      "productionDenyTargetSha256",
    ),
  };
  const targetFactsSha256 = sha256(raw.targetFactsSha256, "targetFactsSha256");
  if (targetFactsSha256 !== deploymentTargetFactsSha256(normalizedTargetFacts)) {
    throw new Error("targetFactsSha256 does not match canonical protected target facts");
  }

  return deepFreeze({
    schemaVersion: 1,
    descriptorId,
    releaseManifestSha256,
    operatorBundleSha256,
    releaseSourceSha,
    imageId,
    imageTag,
    targetFactsSha256,
    ...normalizedTargetFacts,
    issuedAt,
    expiresAt,
    signingWorkflowSourceSha,
    signingWorkflowFileSha256,
    signing: {
      repository,
      workflowRef,
      environment: releaseEnvironment,
      subject: expectedSubject,
      audience,
      issuer: "https://token.actions.githubusercontent.com",
      jobWorkflowRef,
      jobWorkflowSha,
    },
  } as DeploymentTargetDescriptorInput);
}

export function signDeploymentTargetDescriptor(
  descriptorInput: DeploymentTargetDescriptorInput,
  signer: { keyId: string; privateKey: PrivateKeyInput },
): SignedDeploymentTargetDescriptor {
  if (!SAFE_ID.test(signer.keyId)) throw new Error("signature keyId is invalid");
  const descriptor = buildDeploymentTargetDescriptor(descriptorInput);
  const descriptorJson = canonicalJson(descriptor);
  const signature = cryptoSign(
    null,
    Buffer.from(descriptorJson, "utf8"),
    signer.privateKey,
  ).toString("base64url");
  return deepFreeze({
    schemaVersion: 1,
    descriptor,
    descriptorSha256: sha256Hex(descriptorJson),
    signature: { algorithm: "Ed25519", keyId: signer.keyId, value: signature },
  });
}

export function assembleSignedDeploymentTargetDescriptor(
  descriptorInput: DeploymentTargetDescriptorInput,
  signatureInput: { keyId: string; value: string },
): SignedDeploymentTargetDescriptor {
  if (!SAFE_ID.test(signatureInput.keyId)) throw new Error("signature keyId is invalid");
  if (!BASE64URL.test(signatureInput.value)) throw new Error("signature encoding is invalid");
  const descriptor = buildDeploymentTargetDescriptor(descriptorInput);
  const descriptorJson = canonicalJson(descriptor);
  return deepFreeze({
    schemaVersion: 1,
    descriptor,
    descriptorSha256: sha256Hex(descriptorJson),
    signature: { algorithm: "Ed25519", keyId: signatureInput.keyId, value: signatureInput.value },
  });
}

export function deploymentTargetDescriptorArtifactSha256(
  artifact: SignedDeploymentTargetDescriptor,
): string {
  return sha256Hex(canonicalJson(artifact));
}

function validateAttestation(input: DeploymentTargetAttestation): DeploymentTargetAttestation {
  const raw = record(input, "attestation");
  exact(
    raw,
    [
      "schemaVersion",
      "artifactSha256",
      "repository",
      "workflowRef",
      "environment",
      "subject",
      "audience",
      "issuer",
      "jobWorkflowRef",
      "jobWorkflowSha",
      "signingWorkflowSourceSha",
      "signingWorkflowFileSha256",
      "issuedAt",
    ],
    "attestation",
  );
  if (raw.schemaVersion !== 1) throw new Error("attestation.schemaVersion must equal 1");
  return {
    schemaVersion: 1,
    artifactSha256: sha256(raw.artifactSha256, "attestation.artifactSha256"),
    repository: string(raw.repository, "attestation.repository"),
    workflowRef: string(raw.workflowRef, "attestation.workflowRef"),
    environment: string(raw.environment, "attestation.environment") as ReleaseEnvironment,
    subject: string(raw.subject, "attestation.subject"),
    audience: string(raw.audience, "attestation.audience"),
    issuer: string(raw.issuer, "attestation.issuer"),
    jobWorkflowRef: string(raw.jobWorkflowRef, "attestation.jobWorkflowRef"),
    jobWorkflowSha: sha40(raw.jobWorkflowSha, "attestation.jobWorkflowSha"),
    signingWorkflowSourceSha: sha40(
      raw.signingWorkflowSourceSha,
      "attestation.signingWorkflowSourceSha",
    ),
    signingWorkflowFileSha256: sha256(
      raw.signingWorkflowFileSha256,
      "attestation.signingWorkflowFileSha256",
    ),
    issuedAt: isoInstant(raw.issuedAt, "attestation.issuedAt"),
  };
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match pinned trust`);
}

export function verifyDeploymentTargetDescriptor(input: {
  artifact: SignedDeploymentTargetDescriptor;
  attestation: DeploymentTargetAttestation;
  trust: DeploymentTargetTrust;
}): DeploymentTargetDescriptor {
  const artifactRaw = record(input.artifact, "signed descriptor artifact");
  exact(
    artifactRaw,
    ["schemaVersion", "descriptor", "descriptorSha256", "signature"],
    "signed descriptor artifact",
  );
  if (artifactRaw.schemaVersion !== 1) throw new Error("artifact.schemaVersion must equal 1");
  const descriptor = buildDeploymentTargetDescriptor(
    artifactRaw.descriptor as DeploymentTargetDescriptorInput,
  );
  const descriptorJson = canonicalJson(descriptor);
  const descriptorSha256 = sha256(artifactRaw.descriptorSha256, "artifact.descriptorSha256");
  if (descriptorSha256 !== sha256Hex(descriptorJson))
    throw new Error("descriptor hash does not match canonical descriptor bytes");
  const signature = record(artifactRaw.signature, "artifact.signature");
  exact(signature, ["algorithm", "keyId", "value"], "artifact.signature");
  if (signature.algorithm !== "Ed25519") throw new Error("signature algorithm must be Ed25519");
  requireEqual(signature.keyId, input.trust.keyId, "signature key id");
  const signatureValue = string(signature.value, "artifact.signature.value");
  if (!BASE64URL.test(signatureValue)) throw new Error("signature encoding is invalid");
  if (
    !cryptoVerify(
      null,
      Buffer.from(descriptorJson, "utf8"),
      input.trust.publicKey,
      Buffer.from(signatureValue, "base64url"),
    )
  ) {
    throw new Error("descriptor signature verification failed");
  }

  const attestation = validateAttestation(input.attestation);
  requireEqual(
    attestation.artifactSha256,
    deploymentTargetDescriptorArtifactSha256(input.artifact),
    "attestation artifact digest",
  );
  requireEqual(attestation.repository, input.trust.repository, "attestation repository");
  requireEqual(attestation.workflowRef, input.trust.workflowRef, "attestation workflowRef");
  requireEqual(attestation.environment, input.trust.environment, "attestation environment");
  requireEqual(attestation.subject, input.trust.subject, "attestation subject");
  requireEqual(attestation.audience, input.trust.audience, "attestation audience");
  requireEqual(attestation.issuer, input.trust.issuer, "attestation issuer");
  requireEqual(
    attestation.jobWorkflowRef,
    input.trust.jobWorkflowRef,
    "attestation jobWorkflowRef",
  );
  requireEqual(
    attestation.jobWorkflowSha,
    input.trust.signingWorkflowSourceSha,
    "attestation jobWorkflowSha",
  );
  requireEqual(
    attestation.signingWorkflowSourceSha,
    input.trust.signingWorkflowSourceSha,
    "attestation signingWorkflowSourceSha",
  );
  requireEqual(
    attestation.signingWorkflowFileSha256,
    input.trust.signingWorkflowFileSha256,
    "attestation signingWorkflowFileSha256",
  );
  requireEqual(attestation.issuedAt, descriptor.issuedAt, "attestation issuedAt");

  requireEqual(descriptor.releaseEnvironment, input.trust.environment, "descriptor environment");
  requireEqual(
    descriptor.releaseManifestSha256,
    input.trust.releaseManifestSha256,
    "release manifest digest",
  );
  requireEqual(
    descriptor.operatorBundleSha256,
    input.trust.operatorBundleSha256,
    "operator bundle digest",
  );
  requireEqual(descriptor.releaseSourceSha, input.trust.releaseSourceSha, "release source SHA");
  requireEqual(descriptor.imageId, input.trust.imageId, "release image ID");
  requireEqual(descriptor.imageTag, input.trust.imageTag, "release image tag");
  requireEqual(
    descriptor.targetFactsSha256,
    input.trust.targetFactsSha256,
    "protected target facts digest",
  );
  requireEqual(
    descriptor.signingWorkflowSourceSha,
    input.trust.signingWorkflowSourceSha,
    "descriptor signingWorkflowSourceSha",
  );
  requireEqual(
    descriptor.signingWorkflowFileSha256,
    input.trust.signingWorkflowFileSha256,
    "descriptor signingWorkflowFileSha256",
  );
  requireEqual(descriptor.signing.repository, input.trust.repository, "descriptor repository");
  requireEqual(descriptor.signing.workflowRef, input.trust.workflowRef, "descriptor workflowRef");
  requireEqual(
    descriptor.signing.environment,
    input.trust.environment,
    "descriptor signing environment",
  );
  requireEqual(descriptor.signing.subject, input.trust.subject, "descriptor signing subject");
  requireEqual(descriptor.signing.audience, input.trust.audience, "descriptor signing audience");
  requireEqual(descriptor.signing.issuer, input.trust.issuer, "descriptor signing issuer");
  requireEqual(
    descriptor.signing.jobWorkflowRef,
    input.trust.jobWorkflowRef,
    "descriptor jobWorkflowRef",
  );
  requireEqual(
    descriptor.signing.jobWorkflowSha,
    input.trust.signingWorkflowSourceSha,
    "descriptor jobWorkflowSha",
  );

  if (!(input.trust.now instanceof Date) || !Number.isFinite(input.trust.now.getTime()))
    throw new Error("trust.now must be a valid Date");
  const now = input.trust.now.getTime();
  if (now < Date.parse(descriptor.issuedAt)) throw new Error("descriptor is not yet valid");
  if (now >= Date.parse(descriptor.expiresAt)) throw new Error("descriptor has expired");
  return descriptor;
}
