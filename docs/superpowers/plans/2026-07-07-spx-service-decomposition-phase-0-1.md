# SPX Service Decomposition Phase 0/1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the blast radius of LINEJS, OCR, and notification delivery failures while keeping SPX in one repository, one database, and the existing worker lease model.

**Architecture:** Service-oriented monorepo. Add explicit runtime service roles, split HTTP surfaces by role, route notification delivery through an internal line-service contract, and move LINE image/OCR execution behind explicit boundaries. Keep existing `notifier`, `worker`, and `combined` behavior working during migration.

**Tech Stack:** Node 24, TypeScript NodeNext, Fastify 5, Drizzle, MySQL or memory DB, existing HMAC `internal-auth`, existing `notification_outbox`, existing LINEJS adapter in `src/services/line-bot.ts`.

## Global Constraints

- Do not create branches, commits, pushes, or deploys unless the operator explicitly asks.
- Do not read or print secret values from `.env`; use variable names only.
- Keep local relative TypeScript imports using `.js` suffixes.
- Keep `combined` local development mode working.
- Keep `notifier` compatibility until the new `notification-service` and `line-service` roles pass verification.
- Do not introduce a broker, Kubernetes, or database-per-service in Phase 0/1.
- Notification and LINE send failures must mark outbox work retryable; they must not crash web API, workers, or dashboard routes.
- Internal service calls must use bounded timeouts, signed requests, trace context, and retryable error classification.
- The first production topology is single host with multiple containers; separate machines for workers remain supported through `RUN_TEAM_IDS`, `SPX_NODE_ID`, and DB leases.
- Failover workers stay manually assigned at first; do not rely on overlapping `RUN_TEAM_IDS` as the standard deployment policy.

---

## Current Baseline

- `SPX_ROLE=notifier` currently owns HTTP dashboard/API, internal worker notification intake, notification outbox dispatch, and LINEJS sends.
- `SPX_ROLE=worker` already supports multi-host execution using unique `SPX_NODE_ID`, explicit `RUN_TEAM_IDS`, shared MySQL, and DB-backed team runtime leases.
- `src/services/notification-dispatcher.ts` already accepts an injected `sendLineMessage` function and updates `notification_outbox` with lock, retry, sent, and failed state.
- `src/services/internal-auth.ts` already signs and verifies internal HMAC requests.
- `src/services/http-server.ts` currently starts the LINE image listener from the HTTP server, so any HTTP role can accidentally own LINEJS listener work.
- `src/services/line-bot.ts` currently owns LINEJS send, QR login, status, listener reconnect, image buffering, OCR call, extraction persistence, and LINE replies.

---

## Phase Decisions

- Phase 0 prepares contracts and role surfaces without changing production behavior for existing roles.
- Phase 1 extracts LINEJS and notification delivery first because that directly addresses transient 502 risk from LINEJS crashes.
- OCR starts behind an explicit service contract in Phase 1, with local fallback kept until line-service and ocr-service can run independently.
- `notification-service` must call `line-service` over internal HTTP when running as its own role.
- Legacy `notifier` may use the local LINEJS fallback during migration so production can roll forward in smaller steps.
- The dashboard-facing `/api/line-bot/*` routes remain on web API initially, but they become proxy/read routes to line-service once line-service is enabled.

---

## Task 1: Add Runtime Service Roles And HTTP Surfaces

**Purpose:** Prevent new services from accidentally serving the full dashboard/API and make service process identity explicit.

**Files:**

- `src/services/runtime-role.ts`
- `src/config/env.ts`
- `src/app.ts`
- `src/services/http-server.ts`
- `tests/notifier-role-startup.test.ts`
- `docs/env-reference.md`

**Interfaces:**

```ts
export type RuntimeRole =
  | "api"
  | "worker"
  | "notifier"
  | "combined"
  | "notification-service"
  | "line-service"
  | "ocr-service";

export type HttpSurface = "web-api" | "notification-service" | "line-service" | "ocr-service";

export function httpSurfaceForRole(role: RuntimeRole): HttpSurface | null;
export function roleRunsLineService(role: RuntimeRole): boolean;
```

**Steps:**

- [x] Extend `RuntimeRole` and the parser error text to include `notification-service`, `line-service`, and `ocr-service`.
- [x] Keep `api`, `notifier`, and `combined` mapped to the existing web API surface for compatibility.
- [x] Map `worker` to no HTTP surface.
- [x] Map `notification-service`, `line-service`, and `ocr-service` to their own HTTP surfaces.
- [x] Require `SPX_NODE_ID` for `worker`, `notifier`, `notification-service`, `line-service`, and `ocr-service`.
- [x] Make `roleRunsNotifier("notification-service")` return `true`, while `roleRunsNotifier("line-service")` and `roleRunsNotifier("ocr-service")` return `false`.
- [x] Add `roleRunsLineService()` returning `true` for `line-service` and `combined`; keep `notifier` covered only by legacy behavior in later tasks.
- [x] Change `startHttpServer(env.HTTP_PORT)` to `startHttpServer(env.HTTP_PORT, { surface: httpSurfaceForRole(env.SPX_ROLE) ?? "web-api" })`.
- [x] Change `startHttpServer()` to accept `{ surface: HttpSurface }`.
- [x] In `http-server.ts`, register shared Fastify setup, `/health`, and `/ready` for every HTTP surface.
- [x] In `http-server.ts`, register the full dashboard/API route tree only for `surface === "web-api"`.
- [x] In `http-server.ts`, register the existing `internalNotificationController` for `surface === "web-api"` and `surface === "notification-service"` so old and new worker targets both work during migration.
- [x] Update `docs/env-reference.md` so `SPX_ROLE` lists all supported roles and explains which roles expose dashboard routes.

**Tests:**

- [x] Update `tests/notifier-role-startup.test.ts` to assert:
  - `httpSurfaceForRole("worker") === null`
  - `httpSurfaceForRole("line-service") === "line-service"`
  - `httpSurfaceForRole("notification-service") === "notification-service"`
  - `roleRunsNotifier("notification-service") === true`
  - `roleRunsHttp("line-service") === true`
  - `roleRunsWorkers("line-service") === false`
- [x] Add a Fastify registration test if route branching is extracted into a testable helper. Verify line-service surface does not register `/api/settings`.

**Verification Commands:**

```powershell
npm run test -- notifier-role-startup
npm run typecheck:backend
```

**Expected Output:**

- The targeted role startup test exits with code 0.
- Backend TypeScript exits with code 0.

---

## Task 2: Extract A Shared Signed Internal HTTP Client

**Purpose:** Reuse one signed internal HTTP implementation for worker to notification-service, notification-service to line-service, and line-service to ocr-service.

**Files:**

- `src/services/internal-service-client.ts`
- `src/services/notification-client.ts`
- `tests/internal-service-client.test.ts`
- `tests/notification-client-spool.test.ts`

**Interfaces:**

```ts
export interface SignedJsonRequestInput<TBody> {
  url: string;
  sharedSecret: string;
  nodeId: string;
  body: TBody;
  eventKey?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}

export type SignedJsonRequestResult<TData> =
  | { ok: true; status: number; data: TData }
  | { ok: false; status?: number; error: string; retryable: boolean };

export function isRetryableInternalStatus(status: number | undefined): boolean;
export function signedJsonPost<TBody, TData>(
  input: SignedJsonRequestInput<TBody>,
): Promise<SignedJsonRequestResult<TData>>;
```

**Steps:**

- [x] Move timeout signal creation, request signing, response parsing, and retryable status classification from `notification-client.ts` into `internal-service-client.ts`.
- [x] Preserve `idempotency-key` behavior when `eventKey` is provided.
- [x] Classify network errors, timeout, `408`, `429`, and `5xx` as retryable.
- [x] Classify `400`, `401`, `403`, and `422` as non-retryable.
- [x] Keep the `notification-client.ts` public API unchanged by adapting it to `signedJsonPost()`.
- [x] Keep spool behavior identical: retryable failures spool; permanent auth or validation failures do not spool.

**Tests:**

- [x] Add `tests/internal-service-client.test.ts` covering signed headers, event key signing, timeout signal, retryable status classification, non-retryable status classification, and text error bodies.
- [x] Keep `tests/notification-client-spool.test.ts` passing without changing its externally visible assertions.

**Verification Commands:**

```powershell
npm run test -- internal-service-client
npm run test -- notification-client-spool
npm run typecheck:backend
```

**Expected Output:**

- Both targeted tests exit with code 0.
- Backend TypeScript exits with code 0.

---

## Task 3: Add The Line-Service Internal Contract

**Purpose:** Make line-service the only process that needs to import LINEJS for direct sends and listener work.

**Files:**

- `src/services/line-service-contract.ts`
- `src/controllers/internal-line-controller.ts`
- `src/services/http-server.ts`
- `tests/internal-line-controller.test.ts`

**Interfaces:**

```ts
export const LINE_INTERNAL_SEND_PATH = "/internal/line/messages";
export const LINE_INTERNAL_STATUS_PATH = "/internal/line/status";
export const LINE_INTERNAL_LOGIN_PATH = "/internal/line/login";
export const LINE_INTERNAL_GROUPS_PATH = "/internal/line/groups";
export const LINE_INTERNAL_PROFILE_PATH = "/internal/line/profile";
export const LINE_INTERNAL_STORAGE_PATH = "/internal/line/storage";
export const LINE_INTERNAL_LOGOUT_PATH = "/internal/line/logout";

export interface LineServiceSendRequest {
  targetId: string;
  text: string;
  traceId?: string;
  outboxId?: number;
}

export interface LineServiceSendResponse {
  sent: true;
  provider: "linejs";
  providerMessageId?: string;
}

export interface LineServiceStatusResponse {
  enabled: boolean;
  authenticated: boolean;
  qrUrl?: string;
  pincode?: string;
  listenerActive: boolean;
}
```

**Steps:**

- [x] Add `line-service-contract.ts` with request and response types used by controller and client code.
- [x] Add `internal-line-controller.ts` with raw JSON parsing like `internal-notification-controller.ts`.
- [x] Verify `x-spx-node-id`, `x-spx-timestamp`, `x-spx-signature`, and optional `idempotency-key` using `verifyInternalSignature()`.
- [x] Add `POST /internal/line/messages` that validates `targetId` and `text`, calls `sendMessage()` from `line-bot.ts`, and returns a success response only when LINEJS send succeeds.
- [x] Return `503` with retryable details when LINEJS is disabled, QR login is required, or LINEJS send fails in a way notification-service should retry.
- [x] Return `400` for invalid payload shape and `401` for failed signature.
- [x] Add `GET /internal/line/status` protected by signed headers or a signed empty JSON body via `POST /internal/line/status` if keeping one auth style is simpler.
- [x] Add signed admin/read commands for `login`, `groups`, `profile`, `storage`, and `logout` so dashboard-facing LINE Bot routes can stay on web API while LINEJS ownership remains in line-service.
- [x] Register `internalLineController` only when `surface === "line-service"`.
- [x] Do not register dashboard/user routes on the line-service surface.

**Tests:**

- [x] Add `tests/internal-line-controller.test.ts`.
- [x] Stub the line send dependency so the test does not import real LINEJS.
- [x] Cover valid send, invalid auth, invalid payload, disabled LINEJS, and send failure.
- [x] Assert no secret target value is logged or returned in error bodies beyond normal masked operational data.

**Verification Commands:**

```powershell
npm run test -- internal-line-controller
npm run typecheck:backend
```

**Expected Output:**

- The internal line controller test exits with code 0.
- Backend TypeScript exits with code 0.

---

## Task 4: Route Notification Delivery Through Line-Service

**Purpose:** Allow notification-service to run independently without importing LINEJS, while preserving legacy notifier fallback during migration.

**Files:**

- `src/services/line-service-client.ts`
- `src/services/notification-line-sender.ts`
- `src/services/notification-dispatcher.ts`
- `src/services/notifier.ts`
- `src/controllers/line-bot-controller.ts`
- `src/config/env.ts`
- `src/app.ts`
- `tests/line-service-client.test.ts`
- `tests/line-bot-controller-remote.test.ts`
- `tests/notification-dispatcher.test.ts`
- `tests/notifier-role-startup.test.ts`
- `docs/env-reference.md`

**Interfaces:**

```ts
export interface LineServiceClientOptions {
  baseUrl: string;
  sharedSecret: string;
  nodeId: string;
  requestTimeoutMs: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export function sendLineServiceMessage(
  options: LineServiceClientOptions,
  request: LineServiceSendRequest,
): Promise<SendLineMessageResult>;

export interface NotificationLineSenderOptions {
  lineServiceUrl: string;
  sharedSecret: string;
  nodeId: string;
  requestTimeoutMs: number;
  allowLocalFallback: boolean;
}

export function createNotificationLineSender(
  options: NotificationLineSenderOptions,
): (targetId: string, text: string) => Promise<SendLineMessageResult>;
```

**Environment Additions:**

- `LINE_SERVICE_URL`: process-local base URL such as `http://line-service:3003`.
- `LINE_SERVICE_REQUEST_TIMEOUT_MS`: process-local timeout; default `1500`.

Use `NOTIFIER_SHARED_SECRET` as the initial internal shared secret for both worker-to-notification and notification-to-line calls. Rename to a broader service token in a later ADR when operators are ready to rotate secrets.

**Steps:**

- [x] Add env parsing and validation for `LINE_SERVICE_URL` and `LINE_SERVICE_REQUEST_TIMEOUT_MS`.
- [x] Require `LINE_SERVICE_URL` when `SPX_ROLE=notification-service`.
- [x] Allow legacy `SPX_ROLE=notifier` to run without `LINE_SERVICE_URL` by using local fallback.
- [x] Add `line-service-client.ts` using `signedJsonPost()` and `LINE_INTERNAL_SEND_PATH`.
- [x] Add `notification-line-sender.ts` that uses remote line-service when `LINE_SERVICE_URL` is configured.
- [x] Keep local fallback through `sendLineTargetMessage()` only when `allowLocalFallback === true`.
- [x] In `app.ts`, pass `createNotificationLineSender()` into `startNotificationDispatchLoop()`.
- [x] Set `allowLocalFallback` to `false` for `notification-service` and `true` for `notifier` or `combined`.
- [x] Keep `notification-dispatcher.ts` focused on outbox lock, retry, and delivery state; do not import LINEJS there.
- [x] Preserve provider delivery records as `linejs` so existing dashboard/report expectations continue to work.
- [x] Proxy dashboard-facing `/api/line-bot/*` routes through `line-service` when `LINE_SERVICE_URL` is configured so web API does not load local LINEJS for split-mode reads/commands.

**Tests:**

- [x] Add `tests/line-service-client.test.ts` covering signed URL path, success, retryable failure, non-retryable failure, timeout signal, and invalid base URL.
- [x] Add `tests/line-bot-controller-remote.test.ts` covering remote LINE Bot proxy behavior without loading local LINEJS in split mode.
- [x] Extend `tests/notification-dispatcher.test.ts` only if the `SendLineMessageResult` shape changes.
- [x] Extend `tests/notifier-role-startup.test.ts` to assert notification-service cannot be configured without `LINE_SERVICE_URL`.

**Verification Commands:**

```powershell
npm run test -- line-service-client
npm run test -- notification-dispatcher
npm run test -- notifier-role-startup
npm run typecheck:backend
```

**Expected Output:**

- All targeted tests exit with code 0.
- Backend TypeScript exits with code 0.

---

## Task 5: Move LINE Image Listener Ownership Out Of Web API

**Purpose:** Ensure a LINEJS listener crash or reconnect loop cannot take down the dashboard/web API surface.

**Files:**

- `src/app.ts`
- `src/services/http-server.ts`
- `src/services/line-bot.ts`
- `src/services/runtime-role.ts`
- `tests/line-image-listener.test.ts`
- `tests/notifier-role-startup.test.ts`

**Steps:**

- [x] Remove LINE image listener startup from the end of `startHttpServer()`.
- [x] Start the image listener from `app.ts` only when `roleRunsLineService(env.SPX_ROLE)` is true and `LINE_IMAGE_LISTENER_CHAT_ID` is configured.
- [x] Keep recoverable LINEJS listener rejection handling installed at process level for roles that can own LINEJS.
- [x] Make `line-service` the standard production role for `LINE_IMAGE_LISTENER_CHAT_ID`.
- [x] Keep `combined` support for local development.
- [x] Ensure `api` and `notification-service` do not start the image listener even when `LINE_IMAGE_LISTENER_CHAT_ID` is set.
- [x] Log `line-image-listener-started` with service role and node id, without logging chat id in full.

**Tests:**

- [x] Extend `tests/notifier-role-startup.test.ts` or add a focused startup helper test to assert listener ownership by role.
- [x] Keep `tests/line-image-listener.test.ts` passing.
- [x] Add a test for recoverable LINEJS listener rejection handling if moving helper code changes imports.

**Verification Commands:**

```powershell
npm run test -- line-image-listener
npm run test -- notifier-role-startup
npm run typecheck:backend
```

**Expected Output:**

- Targeted tests exit with code 0.
- Backend TypeScript exits with code 0.

---

## Task 6: Add OCR-Service Boundary With Local Fallback

**Purpose:** Prepare OCR extraction to move out of line-service without forcing a risky all-at-once migration.

**Files:**

- `src/services/ocr-service-contract.ts`
- `src/services/ocr-service-client.ts`
- `src/controllers/internal-ocr-controller.ts`
- `src/services/line-image-processor.ts`
- `src/services/line-bot.ts`
- `src/services/http-server.ts`
- `src/config/env.ts`
- `tests/ocr-service-client.test.ts`
- `tests/internal-ocr-controller.test.ts`
- `tests/line-image-listener.test.ts`
- `docs/env-reference.md`

**Interfaces:**

```ts
export const OCR_INTERNAL_READ_LINE_IMAGE_PATH = "/internal/ocr/line-image";

export interface OcrLineImageRequest {
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  traceId: string;
  chatId?: string;
  senderId?: string;
}

export interface OcrLineImageResponse {
  text: string;
  attempts: number;
  validation: {
    ok: boolean;
    reason?: string;
  };
}
```

**Environment Additions:**

- `OCR_SERVICE_URL`: process-local base URL such as `http://ocr-service:3004`.
- `OCR_SERVICE_REQUEST_TIMEOUT_MS`: process-local timeout; default to `CODEX_IMAGE_TIMEOUT_MS + 5000`.

**Steps:**

- [x] Add OCR contract and client using `signedJsonPost()`.
- [x] Add `internal-ocr-controller.ts` that accepts validated image payloads, writes the image to a temp file, calls `readLineImageWithRetry()`, and returns the extraction result.
- [x] Register `internal-ocr-controller` only when `surface === "ocr-service"`.
- [x] Extract LINE image processing from `line-bot.ts` into `line-image-processor.ts` so the listener can choose remote OCR or local OCR.
- [x] Make `line-image-processor.ts` call `OCR_SERVICE_URL` when configured.
- [x] Keep local OCR fallback when `OCR_SERVICE_URL` is not configured and role is `combined` or legacy `line-service` migration mode.
- [x] Enforce the existing `CODEX_IMAGE_MAX_BYTES` and MIME validation before sending to OCR service.
- [x] Keep `persistValidLineImageExtraction()` behavior unchanged.
- [x] Ensure OCR timeout/failure produces a LINE reply but does not crash the LINE listener.

**Tests:**

- [x] Add `tests/ocr-service-client.test.ts` for success, retryable failure, non-retryable auth failure, and timeout signal.
- [x] Add `tests/internal-ocr-controller.test.ts` using a stubbed OCR reader so no provider call is made.
- [x] Extend `tests/line-image-listener.test.ts` to cover remote OCR failure formatting and local fallback behavior.

**Verification Commands:**

```powershell
npm run test -- ocr-service-client
npm run test -- internal-ocr-controller
npm run test -- line-image-listener
npm run typecheck:backend
```

**Expected Output:**

- Targeted tests exit with code 0.
- Backend TypeScript exits with code 0.

---

## Task 7: Add Service Health And Degraded Status Signals

**Purpose:** Let the dashboard/API stay up while showing line-service, notification-service, or OCR degradation.

**Files:**

- `src/services/service-health.ts`
- `src/controllers/dashboard-controller.ts`
- `src/controllers/runtime-status-controller.ts`
- `src/services/http-server.ts`
- `tests/service-health.test.ts`
- `tests/runtime-status-controller.test.ts` if this test file exists after inspection

**Interfaces:**

```ts
export type ServiceHealthState = "ok" | "degraded" | "down";

export interface ServiceHealthSnapshot {
  service: string;
  role: RuntimeRole;
  nodeId: string;
  state: ServiceHealthState;
  checkedAt: string;
  details: Record<string, unknown>;
}
```

**Steps:**

- [x] Add service health snapshots for web API, notification-service, line-service, and ocr-service.
- [x] Keep `/health` shallow: process is alive.
- [x] Keep `/ready` strict enough for load balancers: required dependencies for that surface are usable.
- [x] For web API readiness, do not fail readiness solely because line-service is down; report degraded downstream status instead.
- [x] For notification-service readiness, fail readiness when `LINE_SERVICE_URL` is required and unreachable.
- [x] For line-service readiness, report LINEJS disabled or unauthenticated as degraded rather than crashing.
- [x] For ocr-service readiness, report provider configuration status without exposing provider tokens.
- [x] Add dashboard runtime response fields for downstream service status if the current route shape can accept additive fields safely.

**Tests:**

- [x] Add `tests/service-health.test.ts` covering status classification and secret redaction.
- [x] Add controller tests for additive health fields where the existing controller test pattern supports it.

**Verification Commands:**

```powershell
npm run test -- service-health
npm run typecheck:backend
```

**Expected Output:**

- Targeted tests exit with code 0.
- Backend TypeScript exits with code 0.

---

## Task 8: Update Docker And Deployment Documentation

**Purpose:** Give operators a concrete migration path from current notifier role to split services.

**Files:**

- `docker-compose.yml`
- `docs/deployment.md`
- `docs/architecture.md`
- `docs/env-reference.md`
- `README.md`

**Target Single-Host Topology:**

```text
web-api:
  SPX_ROLE=api
  HTTP_ENABLED=true
  HTTP_PORT=3000

notification-service:
  SPX_ROLE=notification-service
  HTTP_ENABLED=true
  HTTP_PORT=3002
  LINE_SERVICE_URL=http://line-service:3003

line-service:
  SPX_ROLE=line-service
  HTTP_ENABLED=true
  HTTP_PORT=3003
  LINEJS_TEST_ENABLED=true
  LINE_IMAGE_LISTENER_CHAT_ID=<configured by operator>

ocr-service:
  SPX_ROLE=ocr-service
  HTTP_ENABLED=true
  HTTP_PORT=3004

worker-ifn:
  SPX_ROLE=worker
  RUN_TEAM_IDS=2
  NOTIFIER_API_URL=http://notification-service:3002/internal/notification-events

worker-ptwl:
  SPX_ROLE=worker
  RUN_TEAM_IDS=1
  NOTIFIER_API_URL=http://notification-service:3002/internal/notification-events
```

**Steps:**

- [x] Add optional compose services for `web-api`, `notification-service`, `line-service`, and `ocr-service`.
- [x] Keep the existing `notifier` service documented as legacy compatibility until split-service verification passes in production.
- [x] Ensure only web API is published through nginx/public ports.
- [x] Keep line-service, notification-service, and ocr-service on internal Docker network ports unless an operator explicitly exposes them.
- [x] Update worker examples so `NOTIFIER_API_URL` points to notification-service.
- [x] Document that `SPX_NODE_ID` must be unique per service process and per worker machine.
- [x] Document that `RUN_TEAM_IDS` stays explicit and non-overlapping by default.
- [x] Add a rollback path: point workers back to legacy notifier URL and stop split service containers.

**Verification Commands:**

```powershell
npm run typecheck:backend
npm run build
```

**Expected Output:**

- Backend TypeScript exits with code 0.
- Build exits with code 0.

---

## Task 9: Fault-Injection Verification

**Purpose:** Prove the original failure class is contained before changing production default topology.

**Files:**

- `docs/deployment.md`
- `.dockerignore`
- `Dockerfile`
- `package.json`
- Optional script: `scripts/service-fault-check.mjs`
- Controlled publisher script: `scripts/service-fault-publish-notification.mjs`
- Evidence bundle checker: `scripts/service-fault-evidence-check.mjs`
- Outbox evidence script: `scripts/service-fault-outbox-check.mjs`
- Probe script test: `tests/service-fault-check-script.test.ts`
- Publisher script test: `tests/service-fault-publish-notification-script.test.ts`
- Evidence checker test: `tests/service-fault-evidence-check-script.test.ts`
- Outbox script test: `tests/service-fault-outbox-check-script.test.ts`
- Automated guardrail: `tests/service-fault-isolation.test.ts`
- Local service drill: `tests/service-fault-drill-local.test.ts`

**Manual Verification Flow:**

- [ ] Start web API, notification-service, line-service, ocr-service, and one worker in a staging or local Docker topology.
- [ ] Confirm dashboard `/health` and `/ready` are reachable on web API.
- [ ] Publish a test notification event to notification-service and confirm it reaches line-service.
- [ ] Stop line-service.
- [ ] Confirm web API `/health` still returns success.
- [ ] Confirm notification-service marks send attempts failed or retryable in `notification_outbox`.
- [ ] Confirm worker process keeps polling or remains independently healthy.
- [ ] Restart line-service.
- [ ] Confirm notification outbox drains after recovery.
- [ ] Stop ocr-service.
- [ ] Confirm line-service remains alive and replies with OCR timeout/failure behavior when possible.
- [ ] Restart ocr-service and confirm new OCR requests succeed.

Implementation note: the fault-injection runbook and `scripts/service-fault-check.mjs` are in place, and the runtime image copies the read-only probe so operators can execute it from `web-api` inside the Docker network. The runtime image metadata exposes all split-service HTTP ports (`3000`, `3002`, `3003`, and `3004`), and the runtime image healthcheck uses each container's `HTTP_PORT`, so split-service containers on ports 3002, 3003, and 3004 are not falsely checked on port 3000 when run outside the compose override. `.dockerignore` excludes local `.env`, runtime data, logs, memory notes, and tool state from the Docker build context before image verification. The probe exposes `--help` for read-only probe options, supports `--require=web-api,notification-service,line-service,ocr-service` to fail fast when an internal service URL was accidentally omitted from drill evidence, plus `--expect-down=line-service` or `--expect-down=ocr-service` to prove an injected outage actually happened. During the expected line-service outage, the probe uses `--allow-degraded=notification-service` so notification-service must still pass `/health` while `/ready` may fail because its downstream LINE service is intentionally stopped. Probe output includes safe evidence metadata: `requiredServices`, `allowedDownServices`, `allowedDegradedServices`, `expectedDownServices`, `unknownServiceNames`, `missingRequiredServices`, `missingExpectedDownServices`, `expectedDownStillReachableServices`, and `unexpectedFailures`. `scripts/service-fault-publish-notification.mjs` publishes a controlled `notifier_health` drill event only when `--confirm-send-test-notification` is present, exposes `--help` for the mutating publisher safety contract, and its `--dry-run` mode validates endpoint/team/node/drill-id/secret presence without sending a request or creating an outbox row; the real publish prints the drillId/eventKey/status/outbox evidence needed to follow one notification through the drill without printing the shared secret, request payload, LINE targets, or raw response body, and it embeds the concrete drill id into the event key. `scripts/service-fault-outbox-check.mjs` provides read-only aggregate `notification_outbox` evidence for the failed/retryable and post-recovery drain steps without printing notification targets, message bodies, payload JSON, DB credentials, raw event-key filters, or raw error text; it exposes `--help` for the read-only evidence contract, its `--dry-run` mode validates DB env presence, expectation flags, 30-minute lookup window, and event-key hash binding without querying MySQL, and dry-run/live checks now refuse to run without `--event-key-contains` so broad outbox queries cannot become final evidence by accident. The real check supports `--min-total=1` and `--expect-sent` so event-key-filtered checks can prove that a specific drill event existed and reached line-service. It emits `filters.eventKeyContainsSha256` so evidence can be hash-bound to the publisher output. `scripts/service-fault-evidence-check.mjs` now exposes `--help` for the safe evidence workflow and validates every Task 9 manual requirement from either one operator-filled JSON evidence bundle (`--file`) or a directory of per-step evidence files (`--dir`, with filenames discoverable through `--dir-manifest`, scaffolded with `--init-dir`, and readiness-checked with `--dir-status`) without echoing raw evidence values; `--dir-status` also returns metadata-only `nextRequiredEvidence` so operators can see the next file/key to fix in drill order, and `semanticStatus` so structurally complete directories can report failed check names before the final `--dir` validation without printing raw command output. The bundle must include a concrete non-placeholder `drillId` and an `environment` of `staging` or `supervised-production`, publish event keys must be bound to the same concrete `drillId`, outbox evidence must match the publisher event-key hash and use the runbook `sinceMinutes: 30` lookup window, baseline and outage publishes must use distinct event keys, manual worker/OCR evidence must be timestamped and carry the expected `evidenceType` values (`worker-running`, `worker-alive`, `ocr-failure-observed`, `ocr-recovery-observed`) so worker baseline/alive and OCR failure/recovery observations cannot be swapped, and script/manual `checkedAt` timestamps must be present, non-future beyond a small clock-skew allowance, and in drill order. The manual stop/start drill must still be executed in staging or during a supervised production migration window before the rollout is considered fully verified.

Evidence sanitization is also strict: evidence objects must not contain common unsafe raw fields or secret-like key variants such as `raw`, `payload`, `targetId`, `lineTargetId`, `stdout`, `stderr`, `accessToken`, `authorizationHeader`, or `sharedSecretValue`; the checker fails `sanitizedEvidence` instead of allowing raw logs, request bodies, LINE targets, or secret-shaped fields into the final drill bundle.

Baseline and expected-down evidence are intentionally strict: the option arrays must match the runbook command exactly, baseline evidence must not include `--allow-down`, `--allow-degraded`, or `--expect-down`, `allowedDownServices` must be empty, `missingRequiredServices` must be empty, the expected-down service row must be present and down, allowed degraded service rows must be present and degraded, every other required service row must be present and healthy, and all service rows must use the expected internal Docker URLs (`http://web-api:3000/`, `http://notification-service:3002/`, `http://line-service:3003/`, `http://ocr-service:3004/`). Publish evidence is strict: baseline and outage publishes must target `http://notification-service:3002/internal/notification-events`, use the same positive `teamId` and non-empty `nodeId`, use controlled concrete non-placeholder `fault_drill:notifier_health:team:<teamId>:drill:<drillId>:` event keys tied to the same top-level drill id, be non-duplicate, and include a positive `outboxId` plus non-empty `outboxStatus` from `service-fault-publish-notification.mjs`, so scaffold event keys, event keys from another drill id, legacy notifier/web-api publishes, and cross-team publish output cannot satisfy the notification-service proof. Outbox evidence is also strict: baseline checks must prove `--since-minutes=30 --event-key-contains=<eventKey> --min-total=1 --expect-sent --max-pending=0` with no retried rows, outage checks must prove `--since-minutes=30 --event-key-contains=<eventKey> --min-total=1 --expect-failed-attempt` with a pending retryable row before restart, recovery checks must prove `--since-minutes=30 --event-key-contains=<eventKey> --min-total=1 --expect-sent --expect-failed-attempt --max-pending=0` for the same outage notification after it drains, and all outbox outputs must have `mode: "mysql"` plus empty `missingDbEnv` and `expectationFailures` arrays so fixture-mode script output cannot satisfy the shared DB/outbox requirement.

Automated guardrail coverage now proves the closest safe local equivalents:

- web-api readiness remains `ready: true` while configured line-service and ocr-service probes fail.
- notification-service readiness fails when the required line-service probe fails.
- line-service stays ready when LINEJS core is healthy and only OCR-service is down, while reporting downstream OCR as down.
- notification outbox rows are marked retryable when remote line-service delivery is unreachable and local fallback is disabled.

Local Fastify drill coverage starts real loopback web-api, notification-service, line-service, and ocr-service HTTP surfaces on ephemeral ports, then closes and restarts line-service and ocr-service to verify:

- web-api `/ready` stays HTTP 200 and reports the stopped downstream service as `down`.
- notification-service `/ready` changes to HTTP 503 while line-service is stopped.
- notification-service `/ready` recovers after line-service restarts.
- web-api `/ready` stays HTTP 200 while ocr-service is stopped and recovers after ocr-service restarts.

Local Docker smoke coverage now verifies the built runtime image can start split-service HTTP surfaces on an isolated Docker network with `DB_MODE=memory` and dummy non-secret configuration. The smoke starts `web-api`, `notification-service`, `line-service`, and `ocr-service`, runs the runtime image's `service-fault-check.mjs` from inside the Docker network with `--require=web-api,notification-service,line-service,ocr-service`, and allows `line-service` degraded readiness because the smoke intentionally does not use real LINEJS login credentials. This proves image packaging, exposed ports, service DNS, health/readiness wiring, and the non-secret probe path.

Local Docker stop/restart coverage now also verifies the four split HTTP services through the runtime image on an isolated Docker network: baseline readiness, stopped `line-service` with `web-api` still ready and `notification-service` degraded, restarted `line-service`, stopped `ocr-service` with `web-api` still ready and `line-service` alive/degraded, and restarted `ocr-service`. A dummy worker container was intentionally not counted as passing Task 9 because `DB_MODE=memory` gives each container its own in-process database; without a shared DB and seeded team config, a real `SPX_ROLE=worker` process exits cleanly after finding no runnable team runtime. This local Docker drill improves runtime packaging and stop/start confidence, but it does not replace the staging or supervised production drill because it does not publish a real notification event, authenticate LINEJS, run a real worker against shared leases, or inspect shared `notification_outbox` recovery.

Local Docker shared-MySQL coverage now verifies a stronger non-secret local equivalent with the runtime image, a temporary MySQL 8.4 container, baseline `001_create_booking_requests.sql`, seeded dummy team credentials, seeded desired runtime state, and one real `SPX_ROLE=worker` process. The drill starts `web-api`, `notification-service`, `line-service`, `ocr-service`, and the worker on one isolated Docker network; proves baseline service probes pass with `line-service` allowed degraded because LINEJS is intentionally disabled; stops `line-service`; proves `web-api` stays ready, `notification-service` stays healthy but degraded, `ocr-service` stays ready, and `line-service` is truly down via `--expect-down=line-service`; confirms the worker container remains running before and during the outage; confirms `team_runtime_leases` has one active worker lease for `drill-worker-1`; restarts `line-service`; and proves the split-service probes recover. This shared-DB drill exposed one startup regression that is now covered by `tests/team-repository.test.ts`: an existing team with missing legacy `LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_*` app settings must not crash `ensureDefaultTeamFromLegacySettings`. It also exposed a production-split caveat that is now fixed and covered by `tests/db-first-config.test.ts` and `tests/settings-validation.test.ts`: process-local service environment is not shared `app_settings` truth, so workers can boot with `HTTP_ENABLED=false` while HTTP service roles boot with their own surfaces enabled. `tests/db-first-config.test.ts` locks `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_ENABLED`, `HTTP_PORT`, `LINE_SERVICE_URL`, `LINE_SERVICE_REQUEST_TIMEOUT_MS`, `OCR_SERVICE_URL`, and `OCR_SERVICE_REQUEST_TIMEOUT_MS` as process-local service environment so role identity, worker assignment, peer service URLs, and bounded client timeouts cannot be loaded from shared app settings into the wrong role; it also proves DB-first settings load refreshes the mutable runtime `env` object from process env before validation. The follow-up no-toggle Docker drill confirmed `http_enabled_app_settings_rows=0`, `http_enabled_app_settings_rows_after_worker=0`, no DB flip before worker start, no DB flip before line-service restart, `active_worker_leases=1`, and split-service probes recovered after `line-service` restart. This drill still does not replace the staging or supervised production drill because it does not authenticate real LINEJS, publish a real notification event, or inspect real `notification_outbox` recovery.

**Verification Commands:**

```powershell
npm run service:fault-check -- --web-api-url=http://127.0.0.1:9 --allow-down=web-api --timeout-ms=50
npm run test -- service-fault-check-script
npm run test -- service-fault-publish-notification-script
npm run test -- service-fault-evidence-check-script
npm run test -- service-fault-outbox-check-script
npm run test -- notification-dispatcher
npm run test -- service-fault-drill-local
npm run test -- service-fault-isolation
npm run test -- line-image-listener
npm run typecheck
npm run build
```

**Expected Output:**

- Targeted tests exit with code 0.
- Full typecheck exits with code 0.
- Build exits with code 0.
- Web API remains available while line-service is stopped.

---

## Acceptance Criteria

- `SPX_ROLE=line-service` can run LINEJS send/status/listener work without serving the full dashboard/API.
- `SPX_ROLE=notification-service` can accept worker notification events and dispatch outbox rows without importing LINEJS directly.
- `SPX_ROLE=api` or legacy `notifier` web API stays available when line-service is stopped.
- Notification failures from line-service are recorded in `notification_outbox` and retried; they do not crash the process.
- LINE image listener starts only in the service roles intended to own LINEJS.
- OCR failures do not crash line-service, web API, notification-service, or workers.
- Existing `worker`, `notifier`, and `combined` roles keep passing current tests until production migrates.
- Documentation shows both legacy and split-service topologies.

---

## Implementation Order

1. Task 1: Runtime roles and HTTP surfaces.
2. Task 2: Shared signed internal HTTP client.
3. Task 3: Line-service internal contract.
4. Task 4: Notification delivery through line-service.
5. Task 5: LINE image listener ownership.
6. Task 6: OCR-service boundary with local fallback.
7. Task 7: Service health and degraded status.
8. Task 8: Docker and docs.
9. Task 9: Fault-injection verification.

Run the targeted verification commands after each task. Run `npm run typecheck` and `npm run build` after Task 9 before any production rollout.

---

## Rollout Plan

1. Deploy code with legacy `notifier`, current workers, and no `LINE_SERVICE_URL`.
2. Start `line-service` internally with its own `SPX_NODE_ID`.
3. Start legacy notifier with `LINE_SERVICE_URL` and verify notification delivery uses remote line-service.
4. Start `notification-service` internally and point one staging worker to its `/internal/notification-events`.
5. Point all workers to notification-service after outbox and health checks pass.
6. Change web-facing container from legacy notifier to `SPX_ROLE=api` once dashboard-only behavior is verified.
7. Start `ocr-service` and configure line-service with `OCR_SERVICE_URL`.
8. Retain rollback by keeping legacy notifier config ready until at least one successful production observation window completes.

---

## Self-Review Checklist

- [x] The plan covers the ADR/spec Phase 0 contract preparation.
- [x] The plan covers the ADR/spec Phase 1 LINEJS, OCR, and notification boundary.
- [x] Each task lists files, interfaces, steps, tests, verification commands, and expected output.
- [x] The plan avoids immediate database-per-service and broker adoption.
- [x] The plan preserves current multi-host worker behavior through `RUN_TEAM_IDS`, `SPX_NODE_ID`, and DB leases.
- [x] The plan keeps legacy production rollback available.
- [x] The plan prevents line-service and ocr-service from serving the dashboard route tree.
- [x] The plan has no unresolved TODO/TBD/FIXME markers; Task 9 manual fault-injection checkboxes remain intentionally open until a staging or supervised production drill is executed.
