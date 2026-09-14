#!/usr/bin/env node

import { createHash, createHmac, randomUUID } from "node:crypto";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFileBackedSecret } from "./lib/file-backed-secret.mjs";

const OCR_PATH = "/internal/ocr/line-image";
const FIXTURE_PATH = resolve(process.cwd(), "scripts", "task9-ocr-fixture.png");
const EXPECTED_FIXTURE_SHA256 = "cdf7dcb00ca85d93e950cba10ac707c6e27c1dca828673512831454fbd53f73c";
const CONFIRM_VALUE = "I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER";
const MIN_NODE_SECRET_LENGTH = 32;
const MAX_SYNTHETIC_FIXTURE_BYTES = 1024 * 1024;
const PREFLIGHT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_OCR_TIMEOUT_MS = 305_000;
const MAX_OCR_TIMEOUT_MS = 600_000;
const MAX_ID_LENGTH = 128;
const CONCRETE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER_TEXT_PATTERN = /YYYY|HHMM|TODO|TBD|<|>/i;
const ALLOWED_NODE_ENVIRONMENTS = new Set(["development", "test", "production"]);
const allowedExpectations = new Set(["preflight", "down", "up"]);

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function helpText() {
  return `service-fault-ocr-boundary-probe.mjs

Task 9 synthetic OCR boundary probe. --help and --dry-run do not resolve
the signing credential, call the OCR provider, or probe line-service.
Live preflight/down/up runs are mutating because they call the configured OCR
provider with the checked-in synthetic PNG fixture.

Usage:
  node scripts/service-fault-ocr-boundary-probe.mjs --help
  node scripts/service-fault-ocr-boundary-probe.mjs --dry-run
  node scripts/service-fault-ocr-boundary-probe.mjs

Required process environment:
  NODE_ENV=development|test|production
  TASK9_EXPECT=preflight|down|up
  TASK9_DRILL_ID=<concrete-drill-id>
  TASK9_CONFIRM_SYNTHETIC_OCR=${CONFIRM_VALUE}
  SPX_ROLE=line-service
  SPX_NODE_ID=<line-service-node-id>
  OCR_SERVICE_URL=http://ocr-service:3004

A node-scoped signing credential must be mounted by the runtime for live runs.

Optional process environment:
  OCR_SERVICE_REQUEST_TIMEOUT_MS=<positive-ms>  default: 305000; maximum: 600000
  HTTP_PORT=<line-service-port>                 default: 3003

Run --dry-run before every live step. A live preflight must succeed before the
same drill id can record down/up evidence; that state expires after 30 minutes.
`;
}

function required(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceTypeFor(expectation) {
  if (expectation === "down") return "ocr-failure-observed";
  if (expectation === "up") return "ocr-recovery-observed";
  return "ocr-preflight";
}

function failureResult(expectation, failureCode, now, details = {}) {
  const output = {
    ok: false,
    checkedAt: now().toISOString(),
    evidenceType: evidenceTypeFor(expectation),
    note: "Synthetic signed OCR boundary probe did not meet the expected state.",
    failureCode,
  };
  if (
    details.boundaryStatus === "success" ||
    details.boundaryStatus === "http-failure" ||
    details.boundaryStatus === "network-failure"
  ) {
    output.boundaryStatus = details.boundaryStatus;
  }
  if (details.httpStatus === null || Number.isInteger(details.httpStatus)) {
    output.httpStatus = details.httpStatus;
  }
  return { exitCode: 1, output };
}

function resolveNodeSecret(env) {
  const nodeEnvironment = typeof env.NODE_ENV === "string" ? env.NODE_ENV : "";
  if (!ALLOWED_NODE_ENVIRONMENTS.has(nodeEnvironment)) return "";
  const nodeSecret = resolveFileBackedSecret("OCR_NODE_SECRET", env);
  if (nodeSecret.length >= MIN_NODE_SECRET_LENGTH) return nodeSecret;
  if (nodeSecret || nodeEnvironment === "production") return "";
  return resolveFileBackedSecret("NOTIFIER_SHARED_SECRET", env);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseConfiguredPositiveInteger(value, fallback, maximum) {
  const raw = required(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function isConcreteId(value) {
  return (
    value !== "" &&
    value.length <= MAX_ID_LENGTH &&
    CONCRETE_ID_PATTERN.test(value) &&
    /^[A-Za-z0-9]/.test(value) &&
    !PLACEHOLDER_TEXT_PATTERN.test(value)
  );
}

function ocrEndpoint(env) {
  const configured = new URL(required(env.OCR_SERVICE_URL));
  if (
    configured.protocol !== "http:" ||
    configured.hostname !== "ocr-service" ||
    configured.port !== "3004" ||
    configured.pathname !== "/" ||
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash
  ) {
    throw new Error("unexpected OCR service route");
  }
  return new URL(OCR_PATH, configured).toString();
}

function preflightStatePath(drillId) {
  return `/tmp/task9-ocr-preflight-${sha256(drillId).slice(0, 16)}.json`;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function loadSyntheticFixture({
  fixturePath,
  expectedSha256,
  fileSystem = { lstat, open },
}) {
  const pathStat = await fileSystem.lstat(fixturePath, { bigint: true });
  if (pathStat.isSymbolicLink()) throw new Error("fixture must not be a symbolic link");
  if (!pathStat.isFile()) throw new Error("fixture must be a regular file");

  let handle;
  try {
    handle = await fileSystem.open(fixturePath, "r");
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile()) throw new Error("fixture must be a regular file");
    if (!sameFileIdentity(pathStat, openedStat)) throw new Error("fixture identity changed");

    const image = await handle.readFile();
    const finalStat = await handle.stat({ bigint: true });
    if (!finalStat.isFile() || !sameFileIdentity(openedStat, finalStat)) {
      throw new Error("fixture identity changed");
    }
    if (image.length === 0 || image.length > MAX_SYNTHETIC_FIXTURE_BYTES) {
      throw new Error("fixture size invalid");
    }
    const actualHash = sha256(image);
    if (actualHash !== expectedSha256) throw new Error("fixture hash mismatch");
    return { image, hash: actualHash };
  } finally {
    await handle?.close();
  }
}

async function readPreflightState(input, dependencies) {
  const raw = await dependencies.readFile(dependencies.preflightStatePath(input.drillId), "utf8");
  const state = JSON.parse(raw);
  const preflightMs = Date.parse(state.checkedAt);
  const elapsedMs = dependencies.now().getTime() - preflightMs;
  if (
    state.drillId !== input.drillId ||
    state.fixtureSha256 !== input.fixtureSha256 ||
    state.correlationId !== input.correlationId ||
    state.endpoint !== input.endpoint ||
    state.nodeId !== input.nodeId ||
    state.nodeEnvironment !== input.nodeEnvironment ||
    !Number.isFinite(preflightMs) ||
    elapsedMs < 0 ||
    elapsedMs > PREFLIGHT_MAX_AGE_MS
  ) {
    throw new Error("preflight state mismatch");
  }
}

async function writePreflightState(input, checkedAt, dependencies) {
  await dependencies.writeFile(
    dependencies.preflightStatePath(input.drillId),
    JSON.stringify({ ...input, checkedAt }),
    { encoding: "utf8", mode: 0o600 },
  );
}

async function callOcr(input, dependencies) {
  const body = JSON.stringify({
    imageBase64: input.image.toString("base64"),
    mimeType: "image/png",
    traceId: `fault-drill:${input.drillId}:ocr:${input.correlationId}`,
  });
  const timestamp = dependencies.now().toISOString();
  const requestId = randomUUID();
  const signature = createHmac("sha256", input.nodeSecret)
    .update([
      "spx-hmac-v2",
      timestamp,
      input.nodeId,
      requestId,
      input.nodeEnvironment,
      OCR_PATH,
      body,
    ].join("\n"))
    .digest("hex");
  try {
    const response = await dependencies.fetch(input.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": input.nodeId,
        "x-spx-request-id": requestId,
        "x-spx-timestamp": timestamp,
        "x-spx-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    let parsed = null;
    if (response.ok) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    }
    const data = parsed && typeof parsed === "object" ? parsed.data : null;
    return {
      kind: response.ok ? "success" : "http-failure",
      status: response.status,
      validated: Boolean(
        data &&
        typeof data === "object" &&
        typeof data.text === "string" &&
        data.text.trim() &&
        data.validation?.ok === true,
      ),
    };
  } catch {
    return {
      kind: "network-failure",
      status: null,
      validated: false,
    };
  }
}

async function lineServiceState(env, dependencies) {
  const port = parsePositiveInteger(env.HTTP_PORT, 3003);
  const [healthResponse, readyResponse] = await Promise.all([
    dependencies.fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    }),
    dependencies.fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(5_000),
    }),
  ]);
  let readyBody = null;
  try {
    readyBody = await readyResponse.json();
  } catch {
    readyBody = null;
  }
  const readyData = readyBody && typeof readyBody === "object" ? readyBody.data : null;
  const dependencyRows = Array.isArray(readyData?.dependencies) ? readyData.dependencies : [];
  const ocrDependency = dependencyRows.find(
    (dependency) =>
      dependency && typeof dependency === "object" && dependency.service === "ocr-service",
  );
  return {
    healthOk: healthResponse.ok,
    readyOk: readyResponse.ok && readyData?.ready === true,
    ocrState: typeof ocrDependency?.state === "string" ? ocrDependency.state : "missing",
  };
}

export async function runOcrBoundaryProbe(input = {}) {
  const argv = input.argv ?? [];
  const env = input.env ?? {};
  const overrides = input.dependencies ?? {};
  const dependencies = {
    fetch: overrides.fetch ?? globalThis.fetch,
    now: overrides.now ?? (() => new Date()),
    resolveNodeSecret: overrides.resolveNodeSecret ?? (() => resolveNodeSecret(env)),
    lstat: overrides.lstat ?? lstat,
    open: overrides.open ?? open,
    readFile: overrides.readFile ?? readFile,
    writeFile: overrides.writeFile ?? writeFile,
    fixturePath: overrides.fixturePath ?? FIXTURE_PATH,
    preflightStatePath: overrides.preflightStatePath ?? preflightStatePath,
  };
  const expectation = required(env.TASK9_EXPECT);
  const fail = (failureCode, details = {}) =>
    failureResult(expectation, failureCode, dependencies.now, details);

  if (hasFlag(argv, "help")) {
    return { exitCode: 0, output: helpText() };
  }

  const dryRun = hasFlag(argv, "dry-run");
  const drillId = required(env.TASK9_DRILL_ID);
  const expectedFixtureHash = EXPECTED_FIXTURE_SHA256;
  const nodeId = required(env.SPX_NODE_ID);
  const timeoutMs = parseConfiguredPositiveInteger(
    env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
    DEFAULT_OCR_TIMEOUT_MS,
    MAX_OCR_TIMEOUT_MS,
  );
  if (
    !allowedExpectations.has(expectation) ||
    !ALLOWED_NODE_ENVIRONMENTS.has(
      typeof env.NODE_ENV === "string" ? env.NODE_ENV : "",
    ) ||
    !isConcreteId(drillId) ||
    !/^[a-f0-9]{64}$/.test(expectedFixtureHash) ||
    env.TASK9_CONFIRM_SYNTHETIC_OCR !== CONFIRM_VALUE ||
    env.SPX_ROLE !== "line-service" ||
    !isConcreteId(nodeId) ||
    timeoutMs === null
  ) {
    return fail("probe_config_invalid");
  }

  let fixture;
  let endpoint;
  try {
    fixture = await loadSyntheticFixture({
      fixturePath: dependencies.fixturePath,
      expectedSha256: expectedFixtureHash,
      fileSystem: {
        lstat: dependencies.lstat,
        open: dependencies.open,
      },
    });
    endpoint = ocrEndpoint(env);
  } catch {
    return fail("probe_input_unavailable");
  }

  const correlationId = sha256([drillId, fixture.hash, endpoint, nodeId].join("\n"));
  const state = {
    drillId,
    fixtureSha256: fixture.hash,
    correlationId,
    endpoint,
    nodeId,
    nodeEnvironment: env.NODE_ENV,
  };
  if (dryRun) {
    return {
      exitCode: 0,
      output: {
        ok: true,
        dryRun: true,
        expectation,
        drillId,
        fixtureSha256: fixture.hash,
        correlationId,
        endpoint,
        nodeId,
        timeoutMs,
        requiredConfirmation: `TASK9_CONFIRM_SYNTHETIC_OCR=${CONFIRM_VALUE}`,
        note: "Synthetic fixture, role, node, route, timeout, and confirmation are valid; no secret or provider was accessed.",
      },
    };
  }

  let nodeSecret;
  try {
    nodeSecret = await dependencies.resolveNodeSecret(env);
  } catch {
    return fail("node_secret_unavailable");
  }
  if (!nodeSecret) return fail("node_secret_unavailable");

  if (expectation !== "preflight") {
    try {
      await readPreflightState(state, dependencies);
    } catch {
      return fail("preflight_required");
    }
  }

  const result = await callOcr(
    {
      ...state,
      image: fixture.image,
      nodeSecret,
      timeoutMs,
    },
    dependencies,
  );
  const checkedAt = dependencies.now().toISOString();

  if (expectation === "preflight") {
    if (result.kind !== "success" || !result.validated) {
      return fail("preflight_ocr_not_validated", {
        boundaryStatus: result.kind,
        httpStatus: result.status,
      });
    }
    await writePreflightState(state, checkedAt, dependencies);
    return {
      exitCode: 0,
      output: {
        ok: true,
        checkedAt,
        evidenceType: evidenceTypeFor(expectation),
        drillId,
        fixtureSha256: fixture.hash,
        correlationId,
        boundaryStatus: "validated-success",
        httpStatus: result.status,
        note: "Synthetic signed OCR request passed on the configured boundary before fault injection.",
      },
    };
  }

  let lineState;
  try {
    lineState = await lineServiceState(env, dependencies);
  } catch {
    return fail("line_service_observation_failed");
  }

  if (expectation === "down") {
    const retryableFailure =
      result.kind === "network-failure" ||
      (result.kind === "http-failure" && typeof result.status === "number" && result.status >= 500);
    if (
      !retryableFailure ||
      !lineState.healthOk ||
      !lineState.readyOk ||
      lineState.ocrState !== "down"
    ) {
      return fail("expected_ocr_outage_not_observed");
    }
    return {
      exitCode: 0,
      output: {
        ok: true,
        checkedAt,
        evidenceType: evidenceTypeFor(expectation),
        drillId,
        fixtureSha256: fixture.hash,
        correlationId,
        boundaryStatus: "retryable-failure-observed",
        httpStatus: result.status,
        note: "The preflighted synthetic OCR request failed retryably while line-service stayed healthy and ready with OCR down.",
      },
    };
  }

  if (
    result.kind !== "success" ||
    !result.validated ||
    !lineState.healthOk ||
    !lineState.readyOk ||
    lineState.ocrState !== "ok"
  ) {
    return fail("ocr_recovery_not_validated");
  }
  return {
    exitCode: 0,
    output: {
      ok: true,
      checkedAt,
      evidenceType: evidenceTypeFor(expectation),
      drillId,
      fixtureSha256: fixture.hash,
      correlationId,
      boundaryStatus: "validated-success",
      httpStatus: result.status,
      note: "The same synthetic signed OCR request completed successfully after ocr-service recovery.",
    },
  };
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
  );
}

if (isDirectExecution()) {
  let result;
  try {
    result = await runOcrBoundaryProbe({
      argv: process.argv.slice(2),
      env: process.env,
    });
  } catch {
    result = failureResult(
      required(process.env.TASK9_EXPECT),
      "probe_unhandled_failure",
      () => new Date(),
    );
  }
  console.log(typeof result.output === "string" ? result.output : JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
