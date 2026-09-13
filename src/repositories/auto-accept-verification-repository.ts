import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { ensureDashboardTables, getPool } from "../db/client.js";
import { getRawMemoryDb } from "../db/client-memory.js";
import type { AutoAcceptVerificationJob, AutoAcceptVerificationOutcome } from "../services/auto-accept-verifier.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";

export interface VerificationNotification { id: string; outcome: AutoAcceptVerificationOutcome }
export interface VerificationQueueRecord {
  job: AutoAcceptVerificationJob;
  unresolvedRequestIds: number[];
  settledRequestIds: number[];
  attemptCount: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  responseReady: boolean;
  discoveryPending: boolean;
  notifications: VerificationNotification[];
}
export interface VerificationSettlement {
  applied: boolean;
  newlyAcceptedRequestIds: number[];
  newlyFailedRequestIds: number[];
  record: VerificationQueueRecord | null;
  touchedRuleTeamIds: number[];
}
type Row = Record<string, unknown>;
type Query = { sql: string; values: unknown[]; read: boolean };
type Queries<T> = Generator<Query, T, Row[]>;
const select = (sql: string, ...values: unknown[]): Query => ({ sql, values, read: true });
const write = (sql: string, ...values: unknown[]): Query => ({ sql, values, read: false });
const lock = () => env.DB_MODE === "memory" ? "" : " FOR UPDATE";
const stamp = (now: number) => new Date(now).toISOString().slice(0, 19).replace("T", " ");

// One SQL program runs synchronously inside better-sqlite3's transaction, and
// asynchronously on a single MySQL connection. Never pass an async callback to SQLite.
async function transaction<T>(program: () => Queries<T>): Promise<T> {
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const db = getRawMemoryDb();
    return db.transaction(() => {
      const iterator = program();
      let step = iterator.next();
      while (!step.done) {
        const query = step.value;
        const statement = db.prepare(query.sql);
        const rows = query.read ? statement.all(...query.values) as Row[] : (statement.run(...query.values), []);
        step = iterator.next(rows);
      }
      return step.value;
    })();
  }
  const connection = await getPool()!.getConnection();
  try {
    await connection.beginTransaction();
    const iterator = program();
    let step = iterator.next();
    while (!step.done) {
      const query = step.value;
      const [rows] = await connection.query(query.sql, query.values);
      step = iterator.next(query.read ? rows as Row[] : []);
    }
    await connection.commit();
    return step.value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

function record(row: Row): VerificationQueueRecord {
  const job = JSON.parse(String(row.job_json)) as AutoAcceptVerificationJob;
  const settledRequestIds = JSON.parse(String(row.settled_json)) as number[];
  return {
    job, settledRequestIds, unresolvedRequestIds: job.requestIds.filter(id => !settledRequestIds.includes(id)),
    attemptCount: Number(row.attempt_count), nextAttemptAt: Number(row.next_attempt_at),
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    responseReady: Number(row.response_ready) === 1, discoveryPending: Number(row.discovery_pending) === 1,
    notifications: JSON.parse(String(row.notifications_json)) as VerificationNotification[],
  };
}
function validate(job: AutoAcceptVerificationJob): void {
  if (!Number.isSafeInteger(job.teamId) || job.teamId < 1 || !Number.isSafeInteger(job.bookingId) || job.bookingId < 1) throw new Error("Invalid verification job identity");
  if (!job.traceId || job.traceId.length > 160 || !job.ruleId) throw new Error("Invalid verification trace or rule");
  if ((!job.acceptAll && !job.requestIds.length) || job.requestIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Invalid verification request IDs");
  if (job.reservationCount !== undefined && (!Number.isSafeInteger(job.reservationCount) || job.reservationCount < 0)) throw new Error("Invalid verification reservation count");
}
// The durable payload intentionally excludes runtime clients, notification contexts,
// and arbitrary properties attached by callers. Only business trip fields are kept.
function cleanJob(job: AutoAcceptVerificationJob): AutoAcceptVerificationJob {
  const extractedFields: Record<keyof ExtractedTripInfo, true> = {
    request_id: true, booking_id: true, booking_name: true, agency_name: true,
    vehicle_type_id: true, listAgeMs: true, acceptance_status: true, assignment_status: true,
    เส้นทาง: true, ประเภทการจ่าย: true, รูปแบบของทริป: true, ประเภทการเดินทาง: true,
    ประเภทรถ: true, ต้นทาง: true, ปลายทาง: true, วันที่เวลาสแตนบาย: true,
  };
  const allowed = [...Object.keys(extractedFields), "origin", "destination", "vehicle_type", "standby_date", "standby_time", "standby_datetime", "trip_type", "trip_number", "วันที่", "เวลา"];
  const trips = job.trips.map(trip => Object.fromEntries(Object.entries(trip).filter(([key, value]) => allowed.includes(key) && (typeof value === "string" || typeof value === "number"))));
  return { teamId: job.teamId, ruleId: job.ruleId, ruleName: job.ruleName, bookingId: job.bookingId,
    requestIds: [...new Set(job.requestIds)], trips, claimToken: job.claimToken,
    reservationCount: job.reservationCount,
    acceptResult: { ok: job.acceptResult.ok, httpStatus: job.acceptResult.httpStatus, retcode: job.acceptResult.retcode },
    acceptStartedAt: job.acceptStartedAt, acceptFinishedAt: job.acceptFinishedAt, acceptRttMs: job.acceptRttMs,
    listAgeMs: job.listAgeMs, ambiguousAccept: job.ambiguousAccept, acceptAll: job.acceptAll, traceId: job.traceId,
    ...(job.discovery ? { discovery: {
      bookingName: job.discovery.bookingName, agencyName: job.discovery.agencyName,
      expectedAcceptedCount: job.discovery.expectedAcceptedCount,
      verifiedRequestIds: [...new Set((job.discovery.verifiedRequestIds ?? []).filter(id => Number.isSafeInteger(id) && id > 0 && job.requestIds.includes(id)))],
    } } : {}),
  };
}
function* readJob(teamId: number, traceId: string): Queries<VerificationQueueRecord | null> {
  const rows = yield select(`SELECT * FROM auto_accept_verification_jobs WHERE team_id=? AND trace_id=?${lock()}`, teamId, traceId);
  return rows[0] ? record(rows[0]) : null;
}
function* save(record: VerificationQueueRecord): Queries<void> {
  const pending = record.unresolvedRequestIds.length > 0 || record.discoveryPending;
  yield write("UPDATE auto_accept_verification_jobs SET job_json=?,settled_json=?,notifications_json=?,status=?,response_ready=?,discovery_pending=?,attempt_count=?,next_attempt_at=?,lease_token=?,lease_until=? WHERE team_id=? AND trace_id=?",
    JSON.stringify(cleanJob(record.job)), JSON.stringify(record.settledRequestIds), JSON.stringify(record.notifications), pending ? "pending" : "complete",
    record.responseReady ? 1 : 0, record.discoveryPending ? 1 : 0, record.attemptCount, record.nextAttemptAt, record.leaseToken, record.leaseUntil, record.job.teamId, record.job.traceId);
}

function* ensureRequestHistory(job: AutoAcceptVerificationJob, requestId: number | null): Queries<number> {
  const idsJson = JSON.stringify(requestId === null ? [] : [requestId]);
  const [existing] = yield select("SELECT id FROM auto_accept_history WHERE team_id=? AND trace_id=? AND request_ids=? ORDER BY id LIMIT 1", job.teamId, job.traceId, idsJson);
  if (existing) return Number(existing.id);
  const trip = job.trips.find(trip => trip.request_id === requestId) ?? job.trips[0];
  yield write("INSERT INTO auto_accept_history (team_id,rule_id,rule_name,booking_id,request_ids,accepted_count,origin,destination,vehicle_type,status,failure_reason,trace_id,accept_rtt_ms,list_age_ms,verification_status) VALUES (?,?,?,?,?,0,?,?,?,'indeterminate','verify_indeterminate',?,?,?,'indeterminate')",
    job.teamId, job.ruleId, job.ruleName, job.bookingId, idsJson, String(trip?.origin ?? trip?.["ต้นทาง"] ?? "").slice(0,255), String(trip?.destination ?? trip?.["ปลายทาง"] ?? "").slice(0,255), String(trip?.vehicle_type ?? trip?.["ประเภทรถ"] ?? "").slice(0,50), job.traceId, job.acceptRttMs, job.listAgeMs ?? null);
  const [inserted] = yield select("SELECT id FROM auto_accept_history WHERE team_id=? AND trace_id=? AND request_ids=? ORDER BY id LIMIT 1", job.teamId, job.traceId, idsJson);
  return Number(inserted.id);
}

export async function createAutoAcceptVerificationIntent(job: AutoAcceptVerificationJob, options: { now?: number; postRecoveryDelayMs?: number } = {}): Promise<{ created: boolean; record: VerificationQueueRecord }> {
  validate(job);
  const now = options.now ?? Date.now();
  const nonce = randomUUID();
  return transaction(function* () {
    const suffix = env.DB_MODE === "memory" ? "ON CONFLICT(team_id,trace_id) DO NOTHING" : "ON DUPLICATE KEY UPDATE trace_id=trace_id";
    yield write(`INSERT INTO auto_accept_verification_jobs (team_id,trace_id,job_json,settled_json,notifications_json,status,response_ready,discovery_pending,attempt_count,next_attempt_at,lease_token,lease_until,created_at) VALUES (?,?,?,'[]','[]','pending',0,?,0,?,?,?,?) ${suffix}`,
      job.teamId, job.traceId, JSON.stringify(cleanJob({ ...job, ambiguousAccept: true })), job.discovery || (job.acceptAll && !job.requestIds.length) ? 1 : 0,
      now + (options.postRecoveryDelayMs ?? 120000), nonce, now + (options.postRecoveryDelayMs ?? 120000), stamp(now));
    const row = (yield* readJob(job.teamId, job.traceId))!;
    if (row.job.bookingId !== job.bookingId || row.job.ruleId !== job.ruleId) throw new Error("Verification intent identity conflict");
    if (row.leaseToken === nonce) for (const requestId of row.job.requestIds) yield* ensureRequestHistory(row.job, requestId);
    if (row.leaseToken === nonce && !row.job.requestIds.length) yield* ensureRequestHistory(row.job, null);
    return { created: row.leaseToken === nonce, record: row };
  });
}

export async function updateAutoAcceptVerificationResponse(job: AutoAcceptVerificationJob, options: { now?: number } = {}): Promise<boolean> {
  validate(job);
  return transaction(function* () {
    const row = yield* readJob(job.teamId, job.traceId);
    if (!row || row.responseReady || row.attemptCount > 0) return false;
    if (row.job.bookingId !== job.bookingId || row.job.ruleId !== job.ruleId) throw new Error("Verification response identity conflict");
    row.job = cleanJob({ ...job, reservationCount: row.job.reservationCount }); row.responseReady = true; row.leaseToken = null; row.leaseUntil = null; row.nextAttemptAt = options.now ?? Date.now();
    row.unresolvedRequestIds = row.job.requestIds.filter(id => !row.settledRequestIds.includes(id));
    yield* save(row);
    return true;
  });
}

export async function listAutoAcceptVerificationJobs(teamId: number, options: { dueAt?: number; limit?: number } = {}): Promise<VerificationQueueRecord[]> {
  return transaction(function* () {
    const filters = ["team_id=?", "(status='pending' OR notifications_json <> '[]')"];
    const values: unknown[] = [teamId];
    if (options.dueAt !== undefined) { filters.push("next_attempt_at<=?", "(lease_until IS NULL OR lease_until<=?)"); values.push(options.dueAt, options.dueAt); }
    const limit = options.limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.floor(options.limit))}`;
    return (yield select(`SELECT * FROM auto_accept_verification_jobs WHERE ${filters.join(" AND ")} ORDER BY next_attempt_at,trace_id${limit}`, ...values)).map(record);
  });
}
export async function listAutoAcceptVerificationHolds(teamId: number): Promise<VerificationQueueRecord[]> {
  return (await listAutoAcceptVerificationJobs(teamId)).filter(row => row.unresolvedRequestIds.length > 0 || row.discoveryPending);
}

/** Ownership must originate from this rule's durable accept intent, not a manual accept. */
export async function hasOwnedAutoAcceptVerification(teamId: number, bookingId: number, ruleId: string): Promise<boolean> {
  return transaction(function* () {
    const rows = yield select("SELECT q.job_json FROM auto_accept_results r INNER JOIN auto_accept_verification_jobs q ON q.team_id=r.team_id AND q.trace_id=r.winning_attempt_trace_id WHERE r.team_id=? AND r.booking_id=? AND r.status='owned'", teamId, bookingId);
    return rows.some(row => {
      const job = JSON.parse(String(row.job_json)) as AutoAcceptVerificationJob;
      return job.teamId === teamId && job.bookingId === bookingId && job.ruleId === ruleId;
    });
  });
}
export async function claimAutoAcceptVerificationJob(teamId: number, traceId: string, options: { now?: number; leaseMs?: number } = {}): Promise<VerificationQueueRecord | null> {
  const now = options.now ?? Date.now();
  return transaction(function* () {
    const row = yield* readJob(teamId, traceId);
    if (!row || row.nextAttemptAt > now || (row.leaseUntil !== null && row.leaseUntil > now)) return null;
    if (!row.unresolvedRequestIds.length && !row.discoveryPending && !row.notifications.length) return null;
    row.leaseToken = randomUUID(); row.leaseUntil = now + (options.leaseMs ?? 60000); row.attemptCount++;
    yield* save(row); return row;
  });
}
export async function rescheduleAutoAcceptVerificationJob(teamId: number, traceId: string, leaseToken: string, nextAttemptAt: number): Promise<boolean> {
  return transaction(function* () {
    const row = yield* readJob(teamId, traceId);
    if (!row || row.leaseToken !== leaseToken) return false;
    row.nextAttemptAt = nextAttemptAt; row.leaseToken = null; row.leaseUntil = null;
    yield* save(row); return true;
  });
}

function hasReusableLostProof(canonical: Row, record: VerificationQueueRecord, now: number): boolean {
  // Unacknowledged intents (including legacy imports) have a placeholder finish
  // time. A result older than the actual POST must never close those intents.
  if (!record.responseReady || canonical.status !== "lost" || canonical.reason_code !== "verified_lost_race") return false;
  try {
    const evidence = JSON.parse(String(canonical.evidence_json)) as Record<string, unknown> | null;
    if (!evidence || evidence.source !== "detached_verification" || evidence.pendingTabRead !== true || evidence.confirmedTabRead !== true) return false;
    const startedAt = evidence.verificationStartedAt;
    const statuses = evidence.observedStatuses;
    return typeof startedAt === "number" && Number.isSafeInteger(startedAt) && startedAt > 0 && startedAt <= now
      && Number.isSafeInteger(record.job.acceptFinishedAt) && record.job.acceptFinishedAt > 0
      && startedAt >= record.job.acceptFinishedAt
      && !!statuses && typeof statuses === "object" && !Array.isArray(statuses)
      && (statuses as Record<string, unknown>)[String(canonical.request_id)] === 4;
  } catch { return false; }
}

/** Close duplicate history using proof already settled for this team/request.
 * Keep the caller's lease, canonical evidence, quota and notification outbox intact.
 */
export async function reuseAutoAcceptVerificationEvidence(teamId: number, traceId: string, leaseToken: string, options: { now?: number } = {}): Promise<VerificationQueueRecord | null> {
  const now = options.now ?? Date.now();
  return transaction(function* () {
    const row = yield* readJob(teamId, traceId);
    if (!row || row.leaseToken !== leaseToken || row.leaseUntil === null || row.leaseUntil <= now) return null;
    if (row.job.discovery || row.discoveryPending || !row.unresolvedRequestIds.length) return row;
    const placeholders = row.unresolvedRequestIds.map(() => "?").join(",");
    const results = yield select(`SELECT request_id,status,reason_code,evidence_json FROM auto_accept_results WHERE team_id=? AND booking_id=? AND request_id IN (${placeholders}) ORDER BY request_id${lock()}`,
      teamId, row.job.bookingId, ...row.unresolvedRequestIds);
    const settled = new Set(row.settledRequestIds);
    for (const canonical of results) {
      const owned = canonical.status === "owned";
      if (!owned && !hasReusableLostProof(canonical, row, now)) continue;
      const requestId = Number(canonical.request_id);
      const historyId = yield* ensureRequestHistory(row.job, requestId);
      yield write("UPDATE auto_accept_history SET status=?,accepted_count=0,failure_reason=?,error_message=?,verification_status=?,verified_at=? WHERE id=? AND team_id=?",
        owned ? "success" : "failed", owned ? null : "lost_race", owned ? null : "Verification failed: lost_race",
        owned ? "verified_success" : "verified_failed", stamp(now), historyId, teamId);
      settled.add(requestId);
    }
    if (settled.size !== row.settledRequestIds.length) {
      row.settledRequestIds = [...settled];
      row.unresolvedRequestIds = row.job.requestIds.filter(id => !settled.has(id));
      yield* save(row);
    }
    return row;
  });
}

export async function settleAutoAcceptVerificationJob(teamId: number, traceId: string, leaseToken: string, outcome: AutoAcceptVerificationOutcome, options: { now?: number; nextAttemptAt?: number } = {}): Promise<VerificationSettlement> {
  const now = options.now ?? Date.now();
  validate(outcome.job);
  if (outcome.job.teamId !== teamId || outcome.job.traceId !== traceId) throw new Error("Verification outcome scope mismatch");
  return transaction(function* () {
    const row = yield* readJob(teamId, traceId);
    const result: VerificationSettlement = { applied: false, newlyAcceptedRequestIds: [], newlyFailedRequestIds: [], record: row, touchedRuleTeamIds: [] };
    if (!row || row.leaseToken !== leaseToken || row.leaseUntil === null || row.leaseUntil <= now) return result;
    if (row.job.bookingId !== outcome.job.bookingId || row.job.ruleId !== outcome.job.ruleId) throw new Error("Verification outcome identity conflict");
    if (!row.job.acceptAll && outcome.job.requestIds.some(id => !row.job.requestIds.includes(id))) throw new Error("Verification request outside the durable job");
    if (outcome.job.trips.some(trip => typeof trip.booking_id === "number" && trip.booking_id !== row.job.bookingId)) throw new Error("Verification trip booking identity conflict");
    row.job = cleanJob({ ...row.job, trips: outcome.job.trips, requestIds: [...new Set([...row.job.requestIds, ...outcome.job.requestIds])],
      ...(row.job.discovery ? { discovery: { ...row.job.discovery, verifiedRequestIds: [...new Set([...(row.job.discovery.verifiedRequestIds ?? []), ...(outcome.job.discovery?.verifiedRequestIds ?? [])])] } } : {}),
    });
    const [placeholder] = yield select("SELECT id FROM auto_accept_history WHERE team_id=? AND trace_id=? AND request_ids='[]' AND status='indeterminate' LIMIT 1", teamId, traceId);
    if (placeholder) for (const requestId of row.job.requestIds) {
      const [existing] = yield select("SELECT id FROM auto_accept_history WHERE team_id=? AND trace_id=? AND request_ids=? LIMIT 1", teamId, traceId, JSON.stringify([requestId]));
      if (existing) continue;
      yield write("UPDATE auto_accept_history SET request_ids=? WHERE id=? AND team_id=?", JSON.stringify([requestId]), placeholder.id, teamId);
      break;
    }
    row.discoveryPending = outcome.discoveryPending ?? (row.discoveryPending && row.job.requestIds.length === 0);
    if (outcome.discoveryFailureReason) {
      if (!row.job.discovery || row.job.requestIds.length || row.job.ambiguousAccept || row.job.acceptResult.ok || row.job.acceptResult.httpStatus < 400
        || !["session_expired", "accept_api_error"].includes(outcome.discoveryFailureReason)) throw new Error("Discovery failure lacks a definitive accept rejection");
      const historyId = yield* ensureRequestHistory(row.job, null);
      yield write("UPDATE auto_accept_history SET status='failed',failure_reason=?,error_message=?,verification_status='verified_failed',verified_at=?,accept_rtt_ms=? WHERE id=? AND team_id=?",
        outcome.discoveryFailureReason, `Verification failed: ${outcome.discoveryFailureReason}`, stamp(now), row.job.acceptRttMs, historyId, teamId);
      row.discoveryPending = false;
    }
    const settled = new Set(row.settledRequestIds);
    for (const request of outcome.requests) {
      if (!row.job.requestIds.includes(request.requestId)) throw new Error("Verification contains a request outside the durable job");
      if (settled.has(request.requestId)) continue;
      const historyId = yield* ensureRequestHistory(row.job, request.requestId);
      const suffix = env.DB_MODE === "memory" ? "ON CONFLICT(team_id,booking_id,request_id) DO NOTHING" : "ON DUPLICATE KEY UPDATE request_id=request_id";
      yield write(`INSERT INTO auto_accept_results (team_id,booking_id,request_id,status,reason_code) VALUES (?,?,?,'unknown','verification_pending') ${suffix}`, teamId, row.job.bookingId, request.requestId);
      const [canonical] = yield select(`SELECT * FROM auto_accept_results WHERE team_id=? AND booking_id=? AND request_id=?${lock()}`, teamId, row.job.bookingId, request.requestId);
      if (request.status === "indeterminate" && canonical.status !== "owned") continue;
      settled.add(request.requestId);
      // Ownership is absorbing. A second trace cannot decrement its rule or
      // publish another success, and conflicting failure evidence cannot downgrade it.
      if (canonical.status === "owned") {
        yield write("UPDATE auto_accept_history SET status='success',accepted_count=0,failure_reason=NULL,error_message=NULL,verification_status='verified_success',verified_at=? WHERE id=? AND team_id=?", stamp(now), historyId, teamId);
        continue;
      }
      const accepted = request.status === "accepted";
      const reasonCode = accepted ? "verified_owned" : request.reason === "lost_race" ? "verified_lost_race"
        : request.reason === "verify_not_confirmed" ? "verified_not_owned" : request.reason === "session_expired" ? "session_expired"
        : request.reason === "accept_api_error" ? "accept_api_error" : row.job.acceptResult.ok ? "verified_not_owned" : "accept_api_error";
      const status = accepted ? "owned" : reasonCode === "verified_lost_race" || reasonCode === "verified_not_owned" || row.job.acceptResult.ok ? "lost" : "failed";
      yield write("UPDATE auto_accept_results SET status=?,reason_code=?,winning_attempt_trace_id=?,evidence_json=?,resolved_at=?,updated_at=? WHERE team_id=? AND booking_id=? AND request_id=?",
        status, reasonCode, traceId, JSON.stringify({ ...outcome.evidence, source: "detached_verification", httpStatus: row.job.acceptResult.httpStatus, retcode: row.job.acceptResult.retcode, acceptAll: row.job.acceptAll }), stamp(now), stamp(now), teamId, row.job.bookingId, request.requestId);
      yield write("UPDATE auto_accept_history SET accepted_count=?,status=?,failure_reason=?,error_message=?,accept_rtt_ms=?,list_age_ms=?,verification_latency_ms=?,verification_status=?,verified_at=? WHERE id=? AND team_id=?",
        accepted ? 1 : 0, accepted ? "success" : "failed", accepted ? null : request.reason ?? "accept_api_error", accepted ? null : `Verification failed: ${request.reason ?? "accept_api_error"}`, row.job.acceptRttMs, row.job.listAgeMs ?? null, outcome.evidence.verificationLatencyMs ?? null, accepted ? "verified_success" : "verified_failed", stamp(now), historyId, teamId);
      (accepted ? result.newlyAcceptedRequestIds : result.newlyFailedRequestIds).push(request.requestId);
      const singleOutcome: AutoAcceptVerificationOutcome = {
        ...outcome, job: row.job, requests: [request], acceptedRequestIds: accepted ? [request.requestId] : [], failedRequestIds: accepted ? [] : [request.requestId], indeterminateRequestIds: [],
      };
      row.notifications.push({ id: `verification:${teamId}:${row.job.bookingId}:${request.requestId}:${accepted ? "owned" : traceId + ":failed"}`, outcome: singleOutcome });
    }
    if (result.newlyAcceptedRequestIds.length) {
      // IDs are globally unique; use the persisted owner, matching the existing
      // global-rule fallback even when the accepting worker belongs to another team.
      const count = result.newlyAcceptedRequestIds.length;
      const [owner] = yield select(`SELECT team_id FROM notify_rules WHERE id=?${lock()}`, row.job.ruleId);
      if (owner) result.touchedRuleTeamIds.push(Number(owner.team_id));
      yield write("UPDATE notify_rules SET need=CASE WHEN need>? THEN need-? ELSE 0 END,updated_at=? WHERE id=?", count, count, stamp(now), row.job.ruleId);
      yield write("UPDATE notify_rules SET fulfilled=CASE WHEN need<=0 THEN 1 ELSE 0 END,auto_accepted=CASE WHEN need<=0 THEN 1 ELSE 0 END,updated_at=? WHERE id=?", stamp(now), row.job.ruleId);
    }
    row.settledRequestIds = [...settled]; row.unresolvedRequestIds = row.job.requestIds.filter(id => !settled.has(id));
    if (row.discoveryPending) yield* ensureRequestHistory(row.job, null);
    else if (row.job.requestIds.length) yield write("DELETE FROM auto_accept_history WHERE team_id=? AND trace_id=? AND request_ids='[]' AND status='indeterminate'", teamId, traceId);
    row.nextAttemptAt = options.nextAttemptAt ?? now + 30000; row.leaseToken = null; row.leaseUntil = null;
    yield* save(row); result.applied = true; return result;
  });
}

export async function acknowledgeAutoAcceptVerificationNotification(teamId: number, traceId: string, notificationId: string): Promise<boolean> {
  return transaction(function* () {
    const row = yield* readJob(teamId, traceId);
    if (!row || !row.notifications.some(item => item.id === notificationId)) return false;
    row.notifications = row.notifications.filter(item => item.id !== notificationId);
    yield* save(row); return true;
  });
}

/** Import old unresolved history into read-only recovery. No provider call is made. */
export async function importHistoricalAutoAcceptVerifications(teamId: number, options: { now?: number } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const rows = await transaction(function* (): Queries<Row[]> {
    return yield select("SELECT h.* FROM auto_accept_history h WHERE h.team_id=? AND h.status='indeterminate' AND NOT EXISTS (SELECT 1 FROM auto_accept_verification_jobs q WHERE q.team_id=h.team_id AND q.trace_id=h.trace_id) ORDER BY h.id", teamId);
  });
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const traceId = row.trace_id ? String(row.trace_id) : `legacy-verification:${teamId}:${row.id}`;
    const group = groups.get(traceId) ?? []; group.push(row); groups.set(traceId, group);
  }
  let imported = 0;
  for (const [traceId, history] of groups) {
    const source = history[0];
    const requestIds = [...new Set(history.flatMap(row => JSON.parse(String(row.request_ids)) as number[]))];
    if (!requestIds.length) continue;
    const job: AutoAcceptVerificationJob = {
      teamId, traceId, ruleId: String(source.rule_id), ruleName: String(source.rule_name), bookingId: Number(source.booking_id), requestIds,
      trips: requestIds.map(request_id => ({ request_id, origin: String(source.origin ?? ""), destination: String(source.destination ?? ""), vehicle_type: String(source.vehicle_type ?? "") })),
      claimToken: 0, acceptResult: { ok: false, httpStatus: 0 }, acceptStartedAt: now, acceptFinishedAt: now,
      acceptRttMs: Number(source.accept_rtt_ms ?? 0), listAgeMs: source.list_age_ms === null ? undefined : Number(source.list_age_ms), ambiguousAccept: true, acceptAll: false,
    };
    validate(job);
    if (history.some(row => Number(row.booking_id) !== job.bookingId || String(row.rule_id) !== job.ruleId)) throw new Error("Historical verification trace contains conflicting identities");
    const created = await transaction(function* () {
      const nonce = randomUUID();
      const suffix = env.DB_MODE === "memory" ? "ON CONFLICT(team_id,trace_id) DO NOTHING" : "ON DUPLICATE KEY UPDATE trace_id=trace_id";
      yield write(`INSERT INTO auto_accept_verification_jobs (team_id,trace_id,job_json,settled_json,notifications_json,status,response_ready,discovery_pending,attempt_count,next_attempt_at,lease_token,lease_until,created_at) VALUES (?,?,?,'[]','[]','pending',0,0,0,?,?,?,?) ${suffix}`,
        teamId, traceId, JSON.stringify(cleanJob(job)), now, nonce, now, stamp(now));
      const row = (yield* readJob(teamId, traceId))!;
      if (row.leaseToken !== nonce) return false;
      // Split aggregate historical rows only once, preserving their first row ID.
      // The remaining IDs get one pending row from the same helper as new intents.
      for (const previous of history) {
        const ids = JSON.parse(String(previous.request_ids)) as number[];
        if (ids.length) yield write("UPDATE auto_accept_history SET trace_id=?,request_ids=? WHERE id=? AND team_id=? AND status='indeterminate'", traceId, JSON.stringify([ids[0]]), previous.id, teamId);
      }
      for (const requestId of requestIds) yield* ensureRequestHistory(job, requestId);
      row.leaseToken = null; row.leaseUntil = null; yield* save(row);
      return true;
    });
    if (created) imported++;
  }
  return imported;
}
