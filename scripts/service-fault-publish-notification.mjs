#!/usr/bin/env node
// Controlled notification publisher for split-service fault drills.
//
// This script creates one real notification_outbox row through the signed
// internal notification API. It intentionally prints only routing-safe evidence
// such as eventKey, HTTP status, and outbox ids. It never prints the shared
// secret, request payload, LINE targets, DB credentials, or raw response body.

import { createHmac, randomUUID } from "node:crypto";

const INTERNAL_NOTIFICATION_PATH = "/internal/notification-events";
const DEFAULT_TIMEOUT_MS = 5000;
const CONFIRM_FLAG = "confirm-send-test-notification";
const DRY_RUN_FLAG = "dry-run";
const DRILL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER_TEXT_PATTERN = /YYYY|HHMM|TODO|TBD|<|>/i;

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function helpText() {
  return `service-fault-publish-notification.mjs

Controlled Task 9 notification publisher. This script is mutating unless
--dry-run is present; the real publish creates one notification_outbox row and
may send one LINE notification through line-service.

Usage:
  node scripts/service-fault-publish-notification.mjs --help
  node scripts/service-fault-publish-notification.mjs --url=<notification-url> --team-id=<id> --node-id=<node-id> --drill-id=<id> --dry-run
  node scripts/service-fault-publish-notification.mjs --url=<notification-url> --team-id=<id> --node-id=<node-id> --drill-id=<id> --confirm-send-test-notification

Options:
  --url=<notification-url>       Notification service base URL or internal events URL.
  --team-id=<id>                 Staging or supervised-production drill team id.
  --node-id=<node-id>            Worker node id allowed to publish for the team.
  --drill-id=<id>                Concrete staging or supervised-production drill id.
  --team-name=<name>             Optional display name used inside the sent drill event.
  --request-timeout-ms=<ms>      Positive timeout in milliseconds; default 5000.
  --dry-run                      Validate routing/config only; no request, outbox row, or LINE notification.
  --confirm-send-test-notification
                                 Required for the real mutating publish.

Output:
  Prints routing-safe evidence only: checkedAt, url, eventKey, teamId, nodeId,
  drillId, HTTP status, duplicate flag, outboxId, and outboxStatus. It does not
  print the shared secret, request payload, LINE targets, raw response body, or credentials.
`;
}

function parsePositiveInteger(name, defaultValue) {
  const raw = argValue(name);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function requiredTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseDrillId(rawValue) {
  const value = requiredTrimmed(rawValue);
  if (value === "") return "";
  if (PLACEHOLDER_TEXT_PATTERN.test(value) || !DRILL_ID_PATTERN.test(value)) {
    throw new Error(
      "drill-id must be a concrete id using letters, numbers, dots, underscores, or hyphens",
    );
  }
  return value;
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function notificationEndpointFrom(rawUrl) {
  const url = new URL(rawUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    url.pathname = INTERNAL_NOTIFICATION_PATH;
  } else if (path === "/internal") {
    url.pathname = INTERNAL_NOTIFICATION_PATH;
  } else if (!path.endsWith(INTERNAL_NOTIFICATION_PATH)) {
    url.pathname = `${path}${INTERNAL_NOTIFICATION_PATH}`;
  }
  return url;
}

function createSignature(input) {
  const payload = [
    input.timestamp,
    input.nodeId,
    INTERNAL_NOTIFICATION_PATH,
    input.eventKey,
    input.body,
  ].join("\n");
  return createHmac("sha256", input.secret).update(payload).digest("hex");
}

function buildEvent(input) {
  return {
    schemaVersion: 1,
    eventType: "notifier_health",
    severity: "info",
    teamId: input.teamId,
    teamName: input.teamName,
    traceId: input.eventKey,
    message:
      "SPX split-service fault drill test notification. This confirms notification-service can enqueue delivery through line-service.",
    occurredAt: input.occurredAt,
    evidence: {
      drill: "split-service-fault-injection",
      drillId: input.drillId,
      publisher: "service-fault-publish-notification",
    },
  };
}

function successDataFrom(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || parsed.status !== "success") return {};
    const data = parsed.data;
    if (!data || typeof data !== "object") return {};
    return {
      duplicate: Boolean(data.duplicate),
      outboxId: Number.isInteger(data.outboxId) ? data.outboxId : undefined,
      outboxStatus: typeof data.outboxStatus === "string" ? data.outboxStatus : undefined,
    };
  } catch {
    return {};
  }
}

function printAndExit(output, exitCode) {
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = exitCode;
}

async function main() {
  if (hasFlag("help")) {
    console.log(helpText());
    return;
  }

  const urlInput = requiredTrimmed(
    argValue("url") || process.env.NOTIFICATION_SERVICE_URL || process.env.NOTIFIER_API_URL,
  );
  const sharedSecret = requiredTrimmed(process.env.NOTIFIER_SHARED_SECRET);
  const nodeId = requiredTrimmed(argValue("node-id") || process.env.SPX_NODE_ID);
  const teamId = parsePositiveInteger("team-id", null);
  const drillId = parseDrillId(argValue("drill-id"));
  const teamName = requiredTrimmed(argValue("team-name")) || `Fault Drill Team ${teamId}`;
  const timeoutMs = parsePositiveInteger("request-timeout-ms", DEFAULT_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();

  const missingConfig = [];
  if (!urlInput) missingConfig.push("NOTIFICATION_SERVICE_URL or NOTIFIER_API_URL or --url");
  if (!sharedSecret) missingConfig.push("NOTIFIER_SHARED_SECRET");
  if (!nodeId) missingConfig.push("SPX_NODE_ID or --node-id");
  if (teamId === null) missingConfig.push("--team-id");
  if (!drillId) missingConfig.push("--drill-id");

  if (missingConfig.length > 0) {
    printAndExit(
      {
        ok: false,
        checkedAt,
        skipped: true,
        reason: "missing-config",
        missingConfig,
      },
      1,
    );
    return;
  }

  let endpoint;
  try {
    endpoint = notificationEndpointFrom(urlInput);
  } catch {
    printAndExit(
      {
        ok: false,
        checkedAt,
        skipped: true,
        reason: "invalid-url",
      },
      1,
    );
    return;
  }

  if (hasFlag(DRY_RUN_FLAG)) {
    printAndExit(
      {
        ok: true,
        checkedAt,
        dryRun: true,
        url: sanitizeUrl(endpoint.toString()),
        teamId,
        nodeId,
        drillId,
        requiredFlag: `--${CONFIRM_FLAG}`,
      },
      0,
    );
    return;
  }

  if (!hasFlag(CONFIRM_FLAG)) {
    printAndExit(
      {
        ok: false,
        checkedAt,
        skipped: true,
        reason: "confirmation-required",
        requiredFlag: `--${CONFIRM_FLAG}`,
        url: sanitizeUrl(endpoint.toString()),
        teamId,
        nodeId,
        drillId,
      },
      1,
    );
    return;
  }

  const occurredAt = new Date().toISOString();
  const eventKey = `fault_drill:notifier_health:team:${teamId}:drill:${drillId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify(buildEvent({ teamId, teamName, drillId, eventKey, occurredAt }));
  const timestamp = new Date().toISOString();
  const signature = createSignature({
    body,
    timestamp,
    nodeId,
    secret: sharedSecret,
    eventKey,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": eventKey,
        "x-spx-node-id": nodeId,
        "x-spx-timestamp": timestamp,
        "x-spx-signature": signature,
      },
      body,
      signal: controller.signal,
    });
    const responseText = await response.text();
    const successData = response.ok ? successDataFrom(responseText) : {};
    printAndExit(
      {
        ok: response.ok,
        checkedAt,
        url: sanitizeUrl(endpoint.toString()),
        eventKey,
        teamId,
        nodeId,
        drillId,
        status: response.status,
        duplicate: successData.duplicate ?? false,
        outboxId: successData.outboxId,
        outboxStatus: successData.outboxStatus,
      },
      response.ok ? 0 : 1,
    );
  } catch (error) {
    printAndExit(
      {
        ok: false,
        checkedAt,
        url: sanitizeUrl(endpoint.toString()),
        eventKey,
        teamId,
        nodeId,
        drillId,
        errorClass: error instanceof Error ? error.name : "Error",
      },
      1,
    );
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error) => {
  printAndExit(
    {
      ok: false,
      checkedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : "unexpected-error",
    },
    1,
  );
});
