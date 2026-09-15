#!/usr/local/bin/node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeploymentTargetDescriptor } from "../src/services/deployment-target-descriptor.ts";

const DEFAULT_CONFIG_PATH = "/etc/spx-descriptor-signer/config.json";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const CALLER_WORKFLOW_PATH = ".github/workflows/deployment-target-descriptor.yml";
const ROUTE = /^\/[A-Za-z0-9_./-]{1,255}$/;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_JWKS_BYTES = 512 * 1024;

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function noSymlinkPath(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch {
      fail("protected-file-invalid");
    }
    if (stat.isSymbolicLink()) fail("protected-file-invalid");
  }
  return absolute;
}

async function readProtectedBytes(path, maximumBytes, allowNonRoot = false) {
  if (!isAbsolute(path)) fail("protected-file-invalid");
  const absolute = noSymlinkPath(path);
  const before = await lstat(absolute, { bigint: true }).catch(() => fail("protected-file-invalid"));
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size <= 0n
    || before.size > BigInt(maximumBytes)
    || (
      process.platform !== "win32"
      && (Number(before.mode & 0o777n) !== 0o400 || (!allowNonRoot && before.uid !== 0n))
    )
  ) fail("protected-file-invalid");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeNs !== before.mtimeNs
      || opened.ctimeNs !== before.ctimeNs
    ) fail("protected-file-invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || after.size !== BigInt(bytes.length)
    ) fail("protected-file-invalid");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === "protected-file-invalid") throw error;
    fail("protected-file-invalid");
  } finally {
    await handle?.close();
  }
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label}-invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail(`${label}-invalid`);
  return url.toString();
}

function validateConfig(value, options = {}) {
  const keys = [
    "schemaVersion", "listenHost", "listenPort", "path", "keyId", "privateKeyPath",
    "oidcIssuer", "oidcAudience", "oidcJwksUrl", "repository", "repositoryOwner",
    "environments", "trustedWorkflowSha", "trustedWorkflowPath", "maximumBodyBytes",
    "maximumTokenAgeSeconds", "clockToleranceSeconds", "jwksCacheSeconds",
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1) fail("config-invalid");
  if (
    value.listenHost !== "127.0.0.1"
    || !Number.isSafeInteger(value.listenPort)
    || value.listenPort < (options.allowEphemeralPort ? 0 : 1)
    || value.listenPort > 65535
    || !ROUTE.test(value.path ?? "")
    || value.path.includes("//")
    || !SAFE_ID.test(value.keyId ?? "")
    || !isAbsolute(value.privateKeyPath ?? "")
    || !REPOSITORY.test(value.repository ?? "")
    || value.repository.split("/")[0] !== value.repositoryOwner
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.repositoryOwner ?? "")
    || !Array.isArray(value.environments)
    || value.environments.length < 1
    || value.environments.some((environment) => !["production", "staging"].includes(environment))
    || new Set(value.environments).size !== value.environments.length
    || !COMMIT_SHA.test(value.trustedWorkflowSha ?? "")
    || !WORKFLOW_PATH.test(value.trustedWorkflowPath ?? "")
    || !Number.isSafeInteger(value.maximumBodyBytes)
    || value.maximumBodyBytes < 512
    || value.maximumBodyBytes > 4 * 1024 * 1024
    || !Number.isSafeInteger(value.maximumTokenAgeSeconds)
    || value.maximumTokenAgeSeconds < 60
    || value.maximumTokenAgeSeconds > 900
    || !Number.isSafeInteger(value.clockToleranceSeconds)
    || value.clockToleranceSeconds < 0
    || value.clockToleranceSeconds > 120
    || !Number.isSafeInteger(value.jwksCacheSeconds)
    || value.jwksCacheSeconds < 30
    || value.jwksCacheSeconds > 3600
  ) fail("config-invalid");
  const issuer = validateHttpsUrl(value.oidcIssuer, "config").replace(/\/$/, "");
  const audience = validateHttpsUrl(value.oidcAudience, "config");
  const jwksUrl = validateHttpsUrl(value.oidcJwksUrl, "config");
  if (!jwksUrl.startsWith(`${issuer}/`)) fail("config-invalid");
  return Object.freeze({ ...value, oidcIssuer: issuer, oidcAudience: audience, oidcJwksUrl: jwksUrl });
}

function decodeJwtPart(part) {
  if (typeof part !== "string" || part.length < 1 || !/^[A-Za-z0-9_-]+$/.test(part)) fail("oidc-invalid");
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) fail("oidc-invalid");
  return bytes;
}

function parseJwt(token) {
  if (typeof token !== "string" || token.length < 64 || token.length > 32 * 1024) fail("oidc-invalid");
  const parts = token.split(".");
  if (parts.length !== 3) fail("oidc-invalid");
  let header;
  let claims;
  try {
    header = JSON.parse(decodeJwtPart(parts[0]).toString("utf8"));
    claims = JSON.parse(decodeJwtPart(parts[1]).toString("utf8"));
  } catch {
    fail("oidc-invalid");
  }
  if (
    header === null
    || typeof header !== "object"
    || Array.isArray(header)
    || header.alg !== "RS256"
    || !SAFE_ID.test(header.kid ?? "")
    || (header.typ !== undefined && header.typ !== "JWT")
    || Object.keys(header).some((key) => !["alg", "kid", "typ", "x5t"].includes(key))
  ) fail("oidc-invalid");
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) fail("oidc-invalid");
  return Object.freeze({ header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: decodeJwtPart(parts[2]) });
}

function validateClaims(claims, config, nowSeconds) {
  const tolerance = config.clockToleranceSeconds;
  const callerWorkflowRef = `${config.repository}/${CALLER_WORKFLOW_PATH}@${claims.workflow_sha}`;
  if (
    claims.iss !== config.oidcIssuer
    || claims.aud !== config.oidcAudience
    || claims.repository !== config.repository
    || claims.repository_owner !== config.repositoryOwner
    || typeof claims.sub !== "string"
    || typeof claims.job_workflow_ref !== "string"
    || claims.job_workflow_sha !== config.trustedWorkflowSha
    || !COMMIT_SHA.test(claims.workflow_sha ?? "")
    || claims.workflow_ref !== callerWorkflowRef
    || claims.event_name !== "workflow_dispatch"
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.nbf)
    || !Number.isSafeInteger(claims.exp)
    || claims.iat > nowSeconds + tolerance
    || claims.nbf > nowSeconds + tolerance
    || claims.exp < nowSeconds - tolerance
    || nowSeconds - claims.iat > config.maximumTokenAgeSeconds + tolerance
    || claims.exp - claims.iat > config.maximumTokenAgeSeconds + (2 * tolerance)
  ) fail("oidc-denied");
  const environment = config.environments.find(
    (candidate) => claims.sub === `repo:${config.repository}:environment:${candidate}`,
  );
  if (!environment) fail("oidc-denied");
  const expectedWorkflow = `${config.repository}/${config.trustedWorkflowPath}@${config.trustedWorkflowSha}`;
  if (claims.job_workflow_ref !== expectedWorkflow) fail("oidc-denied");
  return environment;
}

function validateJwks(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !Array.isArray(value.keys)
    || value.keys.length < 1
    || value.keys.length > 32
  ) fail("jwks-invalid");
  return value.keys;
}

function createOidcVerifier(config, fetchImplementation) {
  let cachedKeys = null;
  let expiresAt = 0;
  async function keys(nowMilliseconds) {
    if (cachedKeys && nowMilliseconds < expiresAt) return cachedKeys;
    let response;
    try {
      response = await fetchImplementation(config.oidcJwksUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      fail("jwks-unavailable");
    }
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
      fail("jwks-unavailable");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JWKS_BYTES) fail("jwks-invalid");
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > MAX_JWKS_BYTES) fail("jwks-invalid");
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("jwks-invalid");
    }
    cachedKeys = validateJwks(parsed);
    expiresAt = nowMilliseconds + (config.jwksCacheSeconds * 1000);
    return cachedKeys;
  }
  return async function verifyOidc(token) {
    const parsed = parseJwt(token);
    const nowMilliseconds = Date.now();
    const jwk = (await keys(nowMilliseconds)).find((candidate) => candidate?.kid === parsed.header.kid);
    if (
      !jwk
      || jwk.kty !== "RSA"
      || (jwk.use !== undefined && jwk.use !== "sig")
      || (jwk.alg !== undefined && jwk.alg !== "RS256")
    ) fail("oidc-denied");
    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk, format: "jwk" });
    } catch {
      fail("jwks-invalid");
    }
    if (!verify("RSA-SHA256", Buffer.from(parsed.signingInput), publicKey, parsed.signature)) {
      fail("oidc-denied");
    }
    return validateClaims(parsed.claims, config, Math.floor(nowMilliseconds / 1000));
  };
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) fail("body-too-large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function validateSignRequest(bytes, environment, config) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("request-invalid");
  }
  if (
    !exactKeys(value, ["algorithm", "descriptorSha256", "payloadBase64"])
    || value.algorithm !== "Ed25519"
    || !SHA256.test(value.descriptorSha256 ?? "")
    || typeof value.payloadBase64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.payloadBase64)
  ) fail("request-invalid");
  const payload = Buffer.from(value.payloadBase64, "base64");
  if (
    payload.length < 2
    || payload.toString("base64") !== value.payloadBase64
    || createHash("sha256").update(payload).digest("hex") !== value.descriptorSha256
  ) fail("request-invalid");
  let descriptor;
  try {
    descriptor = JSON.parse(payload.toString("utf8"));
  } catch {
    fail("request-invalid");
  }
  if (
    descriptor === null
    || typeof descriptor !== "object"
    || Array.isArray(descriptor)
    || Buffer.from(canonicalJson(descriptor), "utf8").compare(payload) !== 0
  ) fail("request-invalid");
  buildDeploymentTargetDescriptor(descriptor);
  const provenance = descriptor.signing;
  const workflowRef = `${config.repository}/${config.trustedWorkflowPath}@${config.trustedWorkflowSha}`;
  const now = Date.now();
  if (descriptor.releaseEnvironment !== environment
    || provenance.repository !== config.repository
    || provenance.audience !== config.oidcAudience
    || provenance.issuer !== config.oidcIssuer
    || provenance.jobWorkflowRef !== workflowRef
    || provenance.jobWorkflowSha !== config.trustedWorkflowSha
    || Date.parse(descriptor.issuedAt) > now + config.clockToleranceSeconds * 1000
    || Date.parse(descriptor.expiresAt) <= now) fail("request-invalid");
  return payload;
}

function jsonResponse(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

export function createDescriptorSignerServer(inputConfig, options = {}) {
  const config = validateConfig(inputConfig, { allowEphemeralPort: options.privateKey !== undefined });
  let privateKey = options.privateKey;
  if (privateKey) {
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") fail("private-key-invalid");
  }
  const fetchImplementation = options.fetch ?? fetch;
  const verifyOidc = createOidcVerifier(config, fetchImplementation);
  const server = createServer({ maxHeaderSize: 40 * 1024 }, async (request, response) => {
    if (request.url !== config.path) {
      jsonResponse(response, 404, { error: "not-found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      jsonResponse(response, 405, { error: "method-not-allowed" });
      return;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
      jsonResponse(response, 415, { error: "content-type-invalid" });
      return;
    }
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      jsonResponse(response, 403, { error: "request-denied" });
      return;
    }
    const token = authorization.slice("Bearer ".length);
    let environment;
    try {
      environment = await verifyOidc(token);
    } catch {
      jsonResponse(response, 403, { error: "request-denied" });
      return;
    }
    let body;
    try {
      if (Number(request.headers["content-length"]) > config.maximumBodyBytes) fail("body-too-large");
      body = await readBody(request, config.maximumBodyBytes);
    } catch (error) {
      jsonResponse(response, error?.message === "body-too-large" ? 413 : 400, {
        error: error?.message === "body-too-large" ? "request-too-large" : "request-invalid",
      });
      return;
    }
    let payload;
    try {
      payload = validateSignRequest(body, environment, config);
      if (!privateKey) {
        const bytes = await readProtectedBytes(config.privateKeyPath, MAX_CONFIG_BYTES);
        privateKey = createPrivateKey(bytes);
        if (privateKey.asymmetricKeyType !== "ed25519") fail("private-key-invalid");
      }
      const signature = sign(null, payload, privateKey).toString("base64url");
      jsonResponse(response, 200, { keyId: config.keyId, signature });
    } catch {
      jsonResponse(response, 400, { error: "request-invalid" });
    }
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  return server;
}

async function loadProductionServer(configPath) {
  const bytes = await readProtectedBytes(configPath, MAX_CONFIG_BYTES);
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("config-invalid");
  }
  const validated = validateConfig(config);
  const privateBytes = await readProtectedBytes(validated.privateKeyPath, MAX_CONFIG_BYTES);
  let privateKey;
  try {
    privateKey = createPrivateKey(privateBytes);
  } catch {
    fail("private-key-invalid");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("private-key-invalid");
  return { server: createDescriptorSignerServer(validated, { privateKey }), config: validated };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
  if (process.argv.length > 3) {
    process.stderr.write("spx-descriptor-signer-failed\n");
    process.exit(1);
  }
  loadProductionServer(configPath).then(({ server, config }) => {
    server.on("clientError", (_error, socket) => socket.destroy());
    server.listen(config.listenPort, config.listenHost);
    const stop = () => server.close(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }).catch(() => {
    process.stderr.write("spx-descriptor-signer-failed\n");
    process.exitCode = 1;
  });
}
