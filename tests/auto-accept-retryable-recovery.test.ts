import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import { listAutoAcceptVerificationHolds } from "../src/repositories/auto-accept-verification-repository.js";
import { getAutoAcceptResult } from "../src/repositories/auto-accept-result-repository.js";
import { acceptAndNotifyMatchedRules, getAutoAcceptVerificationRunner, NeedBudget, stopAutoAcceptVerificationRecovery } from "../src/services/notifier.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { NotifyRule } from "../src/services/notify-rules.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";

async function checkTeam(teamId: number): Promise<void> {
  const bookingId = 997700 + teamId;
  const requestId = 997800 + teamId;
  const rule: NotifyRule = { id: `retryable-${teamId}`, name: "Retryable recovery", origins: ["A"], destinations: ["B"],
    vehicle_types: ["4W"], need: 1, enabled: true, fulfilled: false, auto_accept: true, accept_all: false, auto_accepted: false };
  const db = getRawMemoryDb();
  db.prepare("INSERT INTO notify_rules (id,team_id,name,origins,destinations,vehicle_types,need,auto_accept) VALUES (?, ?, ?, '[\"A\"]', '[\"B\"]', '[\"4W\"]', 1, 1)")
    .run(rule.id, teamId, rule.name);
  let posts = 0;
  let completeRead = false;
  const list = (owned: boolean) => ({ retcode: 0, message: "", data: { pageno: 1, count: 1, total: 1,
    request_list: [{ request_id: requestId, booking_id: bookingId, request_acceptance_status: owned ? 2 : 1 }] } });
  const client = {
    acceptBookingRequests: async () => {
      posts++;
      return posts === 1
        ? { ok: false, httpStatus: 429, response: { retcode: 130008001, message: "Rate limited" } }
        : { ok: true, httpStatus: 200, response: { retcode: 0, message: "" } };
    },
    fetchBookingRequestList: async (_id: number, options: { tabPendingConfirmation?: boolean }) =>
      !completeRead && !options.tabPendingConfirmation ? null : list(posts > 1),
  } as unknown as ApiClient;
  const options = { teamId, notificationContext: { teamId, teamName: "Test", lineGroupId: "" },
    autoAcceptRules: [rule], needBudget: new NeedBudget(), verificationMode: "detached" as const };
  const trip = { booking_id: bookingId, request_id: requestId, origin: "A", destination: "B", vehicle_type: "4W" };
  const runner = getAutoAcceptVerificationRunner(client, options);
  try {
    await acceptAndNotifyMatchedRules([trip], client, options);
    await runner.idle();
    assert.equal((await listAutoAcceptVerificationHolds(teamId)).length, 1, "partial rate-limited evidence keeps the hold");
    await acceptAndNotifyMatchedRules([trip], client, options);
    assert.equal(posts, 1, "unresolved rate-limited request cannot be accepted again");

    completeRead = true;
    await runner.runDue(Date.now() + 600_000);
    await runner.idle();
    assert.equal(posts, 1, "recovery reads never replay the POST");
    assert.equal((await listAutoAcceptVerificationHolds(teamId)).length, 0);
    assert.equal((await getAutoAcceptResult(teamId, bookingId, requestId))?.status, "failed");

    // A later normal admission can retry an explicit rejected POST after both
    // tabs prove it was not owned. Its process dedupe and quota must be freed.
    await acceptAndNotifyMatchedRules([trip], client, options);
    await runner.idle();
    assert.equal(posts, 2, "retryable settlement releases process dedupe and budget");
    assert.equal((await getAutoAcceptResult(teamId, bookingId, requestId))?.status, "owned");
    assert.equal((db.prepare("SELECT need FROM notify_rules WHERE id=?").get(rule.id) as { need: number }).need, 0);
  } finally {
    await stopAutoAcceptVerificationRecovery(client, teamId);
  }
}

async function main(): Promise<void> {
  Object.assign(env, { SPX_ROLE: "monolith" });
  setLogLevel(LogLevel.ERROR);
  try { await checkTeam(1); await checkTeam(2); }
  finally { await closePool(); }
  console.log("retryable verification recovery: both teams retain unknown holds and release proven rejected admissions");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
