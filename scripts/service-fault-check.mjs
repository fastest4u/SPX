#!/usr/bin/env node
// Read-only split-service health probe for fault-injection drills.
//
// It checks /health and /ready for the web API plus any configured internal
// services. It does not send notifications, mutate DB state, or print secrets.

const DEFAULT_TIMEOUT_MS = 2_000;
const SECRET_KEY_PATTERN = /secret|token|password|cookie|authorization|credential|pincode/i;
const AUTH_PAIR_PATTERN = /\b(authorization)=(Bearer|Basic)\s+\S+/gi;
const SECRET_PAIR_PATTERN =
  /\b(secret|token|password|cookie|authorization|credential|pincode)=\S+/gi;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function helpText() {
  return `service-fault-check.mjs

Read-only Task 9 split-service health/readiness probe. Checks /health and
/ready for web-api plus configured internal services. It does not send
notifications, mutate DB state, or print secrets.

Usage:
  node scripts/service-fault-check.mjs --help
  node scripts/service-fault-check.mjs --require=<services>
  node scripts/service-fault-check.mjs --require=<services> --expect-down=<services> --allow-degraded=<services>

Options:
  --web-api-url=<url>                Web API base URL; defaults to http://127.0.0.1:3000.
  --notification-service-url=<url>   Internal notification-service base URL.
  --line-service-url=<url>           Internal line-service base URL.
  --ocr-service-url=<url>            Internal ocr-service base URL.
  --require=<services>               Comma-separated required service names.
  --expect-down=<services>           Comma-separated services intentionally stopped for the drill.
  --allow-down=<services>            Comma-separated services allowed to be unavailable.
  --allow-degraded=<services>        Services whose /health must pass and /ready must fail.
  --timeout-ms=<ms>                  Positive request timeout in milliseconds; default 2000.

Known services:
  web-api, notification-service, line-service, ocr-service

Output:
  Prints sanitized evidence metadata: required/allowed/expected service lists,
  unknown or missing service names, expected-down services that were still
  reachable, unexpected failures, and redacted /health and /ready results.
`;
}

if (hasFlag("help")) {
  console.log(helpText());
  process.exit();
}

function serviceUrl(name, envName, defaultUrl = "") {
  return argValue(`${name}-url`) || process.env[envName] || defaultUrl;
}

function parseAllowDown() {
  return parseCsvArg("allow-down", "SERVICE_FAULT_ALLOW_DOWN");
}

function parseAllowDegraded() {
  return parseCsvArg("allow-degraded", "SERVICE_FAULT_ALLOW_DEGRADED");
}

function parseRequiredServices() {
  return parseCsvArg("require", "SERVICE_FAULT_REQUIRE");
}

function parseExpectedDownServices() {
  return parseCsvArg("expect-down", "SERVICE_FAULT_EXPECT_DOWN");
}

function parseCsvArg(name, envName) {
  return new Set(
    (argValue(name) || process.env[envName] || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function safeUrl(value, path) {
  try {
    const url = new URL(path, value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function redactText(value) {
  return String(value)
    .replace(AUTH_PAIR_PATTERN, "$1=[redacted]")
    .replace(SECRET_PAIR_PATTERN, "$1=[redacted]")
    .replace(AUTH_HEADER_PATTERN, "$1 [redacted]");
}

function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(item),
    ]),
  );
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function probeEndpoint(baseUrl, path, timeoutMs) {
  const url = safeUrl(baseUrl, path);
  if (!url) return { ok: false, error: "invalid-url" };
  try {
    const response = await fetch(url, { method: "GET", signal: timeoutSignal(timeoutMs) });
    let data = null;
    const text = await response.text();
    if (text.trim()) {
      try {
        data = redactValue(JSON.parse(text));
      } catch {
        data = { text: redactText(text.slice(0, 120)) };
      }
    }
    return { ok: response.ok, status: response.status, url, data };
  } catch (error) {
    return { ok: false, url, error: redactText(error instanceof Error ? error.message : error) };
  }
}

async function probeService(service, timeoutMs) {
  const [health, ready] = await Promise.all([
    probeEndpoint(service.url, "/health", timeoutMs),
    probeEndpoint(service.url, "/ready", timeoutMs),
  ]);
  return {
    name: service.name,
    required: service.required,
    url: safeUrl(service.url, "/"),
    health,
    ready,
  };
}

const timeoutMs = Number(
  argValue("timeout-ms") || process.env.SERVICE_FAULT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
);
const allowDown = parseAllowDown();
const allowDegraded = parseAllowDegraded();
const requiredServices = parseRequiredServices();
const expectedDownServices = parseExpectedDownServices();

const serviceDefinitions = [
  {
    name: "web-api",
    url: serviceUrl("web-api", "WEB_API_URL", "http://127.0.0.1:3000"),
    required: true,
  },
  {
    name: "notification-service",
    url: serviceUrl("notification-service", "NOTIFICATION_SERVICE_URL"),
    required: false,
  },
  {
    name: "line-service",
    url: serviceUrl("line-service", "LINE_SERVICE_URL"),
    required: false,
  },
  {
    name: "ocr-service",
    url: serviceUrl("ocr-service", "OCR_SERVICE_URL"),
    required: false,
  },
];
const knownServiceNames = new Set(serviceDefinitions.map((service) => service.name));
const configuredServiceNames = new Set([
  ...requiredServices,
  ...allowDown,
  ...allowDegraded,
  ...expectedDownServices,
]);
const unknownServiceNames = [...configuredServiceNames].filter(
  (name) => !knownServiceNames.has(name),
);

const services = serviceDefinitions
  .filter((service) => service.url.trim())
  .map((service) => ({
    ...service,
    required:
      service.required ||
      requiredServices.has(service.name) ||
      allowDegraded.has(service.name) ||
      expectedDownServices.has(service.name),
  }));
const invalidConfiguredServices = services
  .filter((service) => !safeUrl(service.url, "/"))
  .map((service) => service.name);

const results = await Promise.all(services.map((service) => probeService(service, timeoutMs)));
const checkedServiceNames = new Set(results.map((service) => service.name));
const missingRequiredServices = [...requiredServices].filter(
  (name) => knownServiceNames.has(name) && !checkedServiceNames.has(name),
);
const missingExpectedDownServices = [...expectedDownServices].filter(
  (name) => knownServiceNames.has(name) && !checkedServiceNames.has(name),
);
const expectedDownStillReachableServices = results
  .filter((service) => expectedDownServices.has(service.name))
  .filter((service) => service.health.ok || service.ready.ok)
  .map((service) => service.name);
const failures = results.filter((service) => {
  if (allowDown.has(service.name) || expectedDownServices.has(service.name)) return false;
  if (allowDegraded.has(service.name)) return !service.health.ok || service.ready.ok;
  if (service.required) return !service.health.ok || !service.ready.ok;
  return !service.health.ok;
});
const ok =
  failures.length === 0 &&
  unknownServiceNames.length === 0 &&
  missingRequiredServices.length === 0 &&
  missingExpectedDownServices.length === 0 &&
  expectedDownStillReachableServices.length === 0 &&
  invalidConfiguredServices.length === 0;

console.log(
  JSON.stringify(
    {
      ok,
      checkedAt: new Date().toISOString(),
      requiredServices: [...requiredServices],
      allowedDownServices: [...allowDown],
      allowedDegradedServices: [...allowDegraded],
      expectedDownServices: [...expectedDownServices],
      unknownServiceNames,
      missingRequiredServices,
      missingExpectedDownServices,
      invalidConfiguredServices,
      expectedDownStillReachableServices,
      unexpectedFailures: failures.map((service) => service.name),
      services: results,
    },
    null,
    2,
  ),
);

if (!ok) {
  process.exitCode = 1;
}
