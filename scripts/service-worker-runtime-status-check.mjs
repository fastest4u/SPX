#!/usr/bin/env node

import { evaluateRuntimeOwner } from "./lib/task9-worker-evaluators.mjs";

const RUNTIME_STATUS_PATH = "/api/runtime/status";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_NODE_HEARTBEAT_AGE_MS = 120_000;
const ALLOWED_WORKER_ROLES = new Set(["worker", "team-worker"]);
const ALLOWED_ARGUMENTS = new Set([
  "url",
  "expected-team-ids",
  "expected-owner-node-id",
  "expected-inactive-node-id",
  "timeout-ms",
]);
const PLACEHOLDER_PATTERN = /YYYY|HHMM|TODO|TBD|<|>|replacement-worker-node-id/i;

const REASONS = {
  authFailed: "SERVICE_WORKER_RUNTIME_STATUS_AUTH_FAILED",
  authRequired: "SERVICE_WORKER_RUNTIME_STATUS_AUTH_REQUIRED",
  configInvalid: "SERVICE_WORKER_RUNTIME_STATUS_CONFIG_INVALID",
  httpFailed: "SERVICE_WORKER_RUNTIME_STATUS_HTTP_FAILED",
  requestFailed: "SERVICE_WORKER_RUNTIME_STATUS_REQUEST_FAILED",
  schemaInvalid: "SERVICE_WORKER_RUNTIME_STATUS_SCHEMA_INVALID",
  validationFailed: "SERVICE_WORKER_RUNTIME_STATUS_VALIDATION_FAILED",
};

class SafeFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function helpText() {
  return `Usage:
  node scripts/service-worker-runtime-status-check.mjs \\
    --url=<https://host/api/runtime/status> \\
    --expected-team-ids=<positive-id[,positive-id...]> \\
    --expected-owner-node-id=<node-id> \\
    [--expected-inactive-node-id=<prior-node-id>]
    [--timeout-ms=<1-${MAX_TIMEOUT_MS}>]

Configuration may also be supplied through:
  SERVICE_WORKER_RUNTIME_STATUS_URL
  SERVICE_WORKER_RUNTIME_EXPECTED_TEAM_IDS
  SERVICE_WORKER_RUNTIME_EXPECTED_OWNER_NODE_ID
  SERVICE_WORKER_RUNTIME_EXPECTED_INACTIVE_NODE_ID
  SERVICE_WORKER_RUNTIME_TIMEOUT_MS

Authentication:
  SERVICE_WORKER_RUNTIME_AUTH_COOKIE must contain the admin session Cookie header value.
  Authentication is never accepted through a command-line argument.

Output:
  On success, prints sanitized runtimeStatusAfter JSON only.
  On failure, prints one fixed safe reason code only.
`;
}

function fail(reason) {
  throw new SafeFailure(reason);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDateString(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseArguments() {
  const values = new Map();
  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      fail(REASONS.configInvalid);
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!ALLOWED_ARGUMENTS.has(name) || values.has(name) || value === "") {
      fail(REASONS.configInvalid);
    }
    values.set(name, value);
  }
  return values;
}

function configuredValue(argumentsByName, argumentName, environmentName) {
  return argumentsByName.get(argumentName) ?? process.env[environmentName];
}

function parseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") fail(REASONS.configInvalid);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(REASONS.configInvalid);
  }
  const loopbackHttpHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const hasSafeProtocol =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHttpHosts.has(url.hostname));
  if (
    !hasSafeProtocol ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== RUNTIME_STATUS_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail(REASONS.configInvalid);
  }
  return url.href;
}

function parseExpectedTeamIds(value) {
  if (typeof value !== "string" || value.trim() === "") fail(REASONS.configInvalid);
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !/^[1-9]\d*$/.test(part))) fail(REASONS.configInvalid);
  const ids = parts.map(Number);
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    fail(REASONS.configInvalid);
  }
  return ids;
}

function parseExpectedOwnerNodeId(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.length > 255 ||
    PLACEHOLDER_PATTERN.test(value)
  ) {
    fail(REASONS.configInvalid);
  }
  return value;
}

function parseTimeout(value) {
  const normalized = value ?? String(DEFAULT_TIMEOUT_MS);
  if (typeof normalized !== "string" || !/^\d+$/.test(normalized)) {
    fail(REASONS.configInvalid);
  }
  const timeoutMs = Number(normalized);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    fail(REASONS.configInvalid);
  }
  return timeoutMs;
}

function readOptions() {
  const argumentsByName = parseArguments();
  const expectedOwnerNodeId = parseExpectedOwnerNodeId(
    configuredValue(
      argumentsByName,
      "expected-owner-node-id",
      "SERVICE_WORKER_RUNTIME_EXPECTED_OWNER_NODE_ID",
    ),
  );
  const inactiveValue = configuredValue(
    argumentsByName,
    "expected-inactive-node-id",
    "SERVICE_WORKER_RUNTIME_EXPECTED_INACTIVE_NODE_ID",
  );
  const expectedInactiveNodeId =
    inactiveValue === undefined ? null : parseExpectedOwnerNodeId(inactiveValue);
  if (expectedInactiveNodeId === expectedOwnerNodeId) fail(REASONS.configInvalid);
  return {
    url: parseUrl(
      configuredValue(argumentsByName, "url", "SERVICE_WORKER_RUNTIME_STATUS_URL"),
    ),
    expectedTeamIds: parseExpectedTeamIds(
      configuredValue(
        argumentsByName,
        "expected-team-ids",
        "SERVICE_WORKER_RUNTIME_EXPECTED_TEAM_IDS",
      ),
    ),
    expectedOwnerNodeId,
    expectedInactiveNodeId,
    timeoutMs: parseTimeout(
      configuredValue(argumentsByName, "timeout-ms", "SERVICE_WORKER_RUNTIME_TIMEOUT_MS"),
    ),
  };
}

function readAuthCookie() {
  const cookie = process.env.SERVICE_WORKER_RUNTIME_AUTH_COOKIE;
  if (
    typeof cookie !== "string" ||
    cookie.trim() === "" ||
    cookie.includes("\r") ||
    cookie.includes("\n")
  ) {
    fail(REASONS.authRequired);
  }
  return cookie;
}

function selectRuntimeEvidence(workerLeases, options, runtimeData) {
  if (
    !isObject(workerLeases) ||
    !validDateString(workerLeases.generatedAt) ||
    !Array.isArray(workerLeases.teams)
  ) {
    fail(REASONS.schemaInvalid);
  }

  const checkedAt = workerLeases.generatedAt;
  const checkedAtMs = Date.parse(checkedAt);
  const leases = [];
  let ownerNode = null;

  for (const teamId of options.expectedTeamIds) {
    const matchingTeams = workerLeases.teams.filter(
      (team) => isObject(team) && team.teamId === teamId,
    );
    if (matchingTeams.length !== 1) fail(REASONS.validationFailed);

    const team = matchingTeams[0];
    if (!isObject(team.lease) || !isObject(team.node)) fail(REASONS.schemaInvalid);
    const lease = team.lease;
    const node = team.node;
    if (
      typeof lease.ownerNodeId !== "string" ||
      typeof lease.ownerRole !== "string" ||
      typeof lease.active !== "boolean" ||
      !validDateString(lease.heartbeatAt) ||
      !validDateString(lease.leaseExpiresAt) ||
      typeof node.nodeId !== "string" ||
      typeof node.role !== "string" ||
      !validDateString(node.lastHeartbeatAt) ||
      typeof node.stale !== "boolean"
    ) {
      fail(REASONS.schemaInvalid);
    }

    const leaseHeartbeatMs = Date.parse(lease.heartbeatAt);
    const leaseExpiresMs = Date.parse(lease.leaseExpiresAt);
    const nodeHeartbeatMs = Date.parse(node.lastHeartbeatAt);
    if (
      lease.ownerNodeId !== options.expectedOwnerNodeId ||
      !ALLOWED_WORKER_ROLES.has(lease.ownerRole) ||
      lease.active !== true ||
      leaseHeartbeatMs >= leaseExpiresMs ||
      leaseExpiresMs <= checkedAtMs ||
      node.nodeId !== options.expectedOwnerNodeId ||
      node.role !== lease.ownerRole ||
      !ALLOWED_WORKER_ROLES.has(node.role) ||
      node.stale !== false ||
      nodeHeartbeatMs > checkedAtMs ||
      checkedAtMs - nodeHeartbeatMs > MAX_NODE_HEARTBEAT_AGE_MS
    ) {
      fail(REASONS.validationFailed);
    }

    const selectedNode = {
      nodeId: node.nodeId,
      role: node.role,
      lastHeartbeatAt: node.lastHeartbeatAt,
    };
    if (ownerNode === null) {
      ownerNode = selectedNode;
    } else if (
      ownerNode.nodeId !== selectedNode.nodeId ||
      ownerNode.role !== selectedNode.role ||
      ownerNode.lastHeartbeatAt !== selectedNode.lastHeartbeatAt
    ) {
      fail(REASONS.validationFailed);
    }

    leases.push({
      teamId,
      ownerNodeId: lease.ownerNodeId,
      ownerRole: lease.ownerRole,
      active: lease.active,
      heartbeatAt: lease.heartbeatAt,
      leaseExpiresAt: lease.leaseExpiresAt,
    });
  }

  if (ownerNode === null) fail(REASONS.validationFailed);
  const result = {
    ok: true,
    checkedAt,
    expectedTeamIds: [...options.expectedTeamIds],
    expectedOwnerNodeId: options.expectedOwnerNodeId,
    leases,
    nodes: [ownerNode],
  };
  if (options.expectedInactiveNodeId !== null) {
    if (!Array.isArray(runtimeData?.nodes) || !Array.isArray(runtimeData?.leases)) {
      fail(REASONS.schemaInvalid);
    }
    const priorNodes = runtimeData.nodes.filter(
      (node) => isObject(node) && node.nodeId === options.expectedInactiveNodeId,
    );
    if (priorNodes.length !== 1 || !isObject(priorNodes[0].heartbeat)) {
      fail(REASONS.validationFailed);
    }
    const heartbeatState = priorNodes[0].heartbeat.state;
    if (!["fresh", "degraded"].includes(heartbeatState)) fail(REASONS.schemaInvalid);
    const expectedTeams = new Set(options.expectedTeamIds);
    const activePriorLeases = runtimeData.leases.filter(
      (lease) =>
        isObject(lease) &&
        expectedTeams.has(lease.teamId) &&
        lease.ownerNodeId === options.expectedInactiveNodeId,
    );
    for (const teamId of options.expectedTeamIds) {
      const checked = evaluateRuntimeOwner(
        [
          { teamId, nodeId: options.expectedOwnerNodeId, active: true, heartbeatAgeMs: 0 },
          {
            teamId,
            nodeId: options.expectedInactiveNodeId,
            active: activePriorLeases.some((lease) => lease.teamId === teamId),
            heartbeatAgeMs: MAX_NODE_HEARTBEAT_AGE_MS,
          },
        ],
        {
          teamId,
          expectedActiveNodeId: options.expectedOwnerNodeId,
          expectedInactiveNodeId: options.expectedInactiveNodeId,
          maxHeartbeatAgeMs: MAX_NODE_HEARTBEAT_AGE_MS,
        },
      );
      if (!checked.ok) fail(REASONS.validationFailed);
    }
    result.inactiveOwner = {
      nodeId: options.expectedInactiveNodeId,
      activeLeaseCount: activePriorLeases.length,
      heartbeatState,
    };
  }
  return result;
}

async function requestRuntimeStatus(options, authCookie) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "GET",
      headers: { Cookie: authCookie },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) fail(REASONS.authFailed);
    if (!response.ok) fail(REASONS.httpFailed);

    let body;
    try {
      body = await response.json();
    } catch {
      fail(REASONS.schemaInvalid);
    }
    if (
      !isObject(body) ||
      !isObject(body.data) ||
      !isObject(body.data.readModels)
    ) {
      fail(REASONS.schemaInvalid);
    }
    return selectRuntimeEvidence(body.data.readModels.workerLeases, options, body.data);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(helpText());
    return;
  }

  const options = readOptions();
  const authCookie = readAuthCookie();
  const evidence = await requestRuntimeStatus(options, authCookie);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  const reason = error instanceof SafeFailure ? error.reason : REASONS.requestFailed;
  console.error(reason);
  process.exitCode = 1;
});
