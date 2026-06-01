import assert from "node:assert/strict";
import { NeedBudget } from "../src/services/notifier.js";

const budget = new NeedBudget();

// First claim initializes the per-rule budget from dbNeed, then grants min(requested, available).
assert.equal(budget.claim("r", 3, 5), 3); // init 3, grant min(5,3)=3, remaining 0
assert.equal(budget.claim("r", 3, 2), 0); // dbNeed ignored after init; remaining 0 => grant 0

// Releasing returns slots to the budget for re-claim.
budget.release("r", 2);
assert.equal(budget.claim("r", 99, 1), 1); // grant min(1,2)=1, remaining 1
assert.equal(budget.claim("r", 99, 5), 1); // grant min(5,1)=1, remaining 0

// Different rule ids track independent budgets.
assert.equal(budget.claim("s", 2, 10), 2);

// release with count <= 0 is a no-op.
budget.release("s", 0);
assert.equal(budget.claim("s", 2, 1), 0);

// release on a never-claimed rule is a no-op; the next claim initializes from dbNeed.
budget.release("z", 5);
assert.equal(budget.claim("z", 4, 10), 4);

console.log("need-budget: all assertions passed");
