import assert from "node:assert/strict";
import { NeedBudget } from "../src/services/notifier.js";

const budget = new NeedBudget();

// First claim initializes the per-rule budget from dbNeed, then grants min(requested, available).
const first = budget.claim("r", 3, 5);
assert.equal(first.granted, 3); // init 3, grant min(5,3)=3, remaining 0
assert.equal(budget.claim("r", 3, 2).granted, 0); // dbNeed ignored after init; remaining 0 => grant 0

// Releasing returns slots to the budget for re-claim (bounded by the token's batch).
budget.release("r", first.token, 2);
assert.equal(budget.claim("r", 99, 1).granted, 1); // grant min(1,2)=1, remaining 1
assert.equal(budget.claim("r", 99, 5).granted, 1); // grant min(5,1)=1, remaining 0

// Different rule ids track independent budgets.
const s = budget.claim("s", 2, 10);
assert.equal(s.granted, 2);

// release with count <= 0 is a no-op.
budget.release("s", s.token, 0);
assert.equal(budget.claim("s", 2, 1).granted, 0);

// release with an unknown token is a no-op; the next claim initializes from dbNeed.
budget.release("z", 12345, 5);
assert.equal(budget.claim("z", 4, 10).granted, 4);

// ── Cross-tick in-flight accounting ──────────────────────────────────────
{
  const b = new NeedBudget();
  // Tick 1: rule need=2, both slots claimed — accepts now in flight.
  const t1 = b.claim("t", 2, 2);
  assert.equal(t1.granted, 2);

  // Tick 2 starts while both accepts are still in flight. The DB snapshot
  // still says need=2 (decrement not committed yet), but in-flight claims
  // must be subtracted — this is the over-accept bug the budget prevents.
  b.beginTick();
  assert.equal(b.claim("t", 2, 2).granted, 0);

  // One accept fails verification and is released — immediately retryable.
  b.release("t", t1.token, 1);
  const retry = b.claim("t", 2, 1);
  assert.equal(retry.granted, 1);

  // The other accept commits its DB decrement (need 2 -> 1) and settles.
  // A stale snapshot (still need=2) within the same tick must NOT re-grant
  // the settled slot.
  b.settle("t", t1.token, 1);
  assert.equal(b.claim("t", 2, 1).granted, 0);

  // Tick 3: fresh snapshot reflects the decrement (need=1); the retried
  // claim from tick 2 is still in flight, so nothing is grantable.
  b.beginTick();
  assert.equal(b.claim("t", 1, 1).granted, 0);
}

// ── Claim TTL: leaked claims expire, and late release/settle is terminal ──
{
  const b = new NeedBudget();
  const leaked = b.claim("u", 1, 1);
  assert.equal(leaked.granted, 1);

  // The flow crashed without release/settle: after the TTL the slot returns.
  b.beginTick(Date.now() + 121_000);
  assert.equal(b.claim("u", 1, 1).granted, 1);

  // The zombie flow finally finishes and releases its pruned claim — this
  // must be a no-op (no double-credit, no theft of the live claim above).
  b.release("u", leaked.token, 1);
  assert.equal(b.claim("u", 1, 1).granted, 0);
}

// release/settle are bounded by the token's own batch — over-counted calls
// cannot inflate availability.
{
  const b = new NeedBudget();
  const t = b.claim("v", 2, 2);
  assert.equal(t.granted, 2);
  b.release("v", t.token, 99); // batch only holds 2
  assert.equal(b.claim("v", 2, 99).granted, 2);
}

console.log("need-budget: all assertions passed");
