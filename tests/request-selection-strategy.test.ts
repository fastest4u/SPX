import assert from "node:assert/strict";
import { applyRequestSelectionStrategy } from "../src/services/notifier.js";

// 1. Edge cases: empty array and single element
assert.deepEqual(applyRequestSelectionStrategy([]), []);
assert.deepEqual(applyRequestSelectionStrategy([42]), [42]);

// 2. "first" preserves order
const list1 = [1, 2, 3, 4, 5];
assert.deepEqual(applyRequestSelectionStrategy([...list1], "first"), [1, 2, 3, 4, 5]);

// 3. "last" reverses order
const list2 = [1, 2, 3, 4, 5];
assert.deepEqual(applyRequestSelectionStrategy([...list2], "last"), [5, 4, 3, 2, 1]);

// 4. "random" preserves elements and length
const list3 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const shuffled = applyRequestSelectionStrategy([...list3], "random");
assert.equal(shuffled.length, list3.length);
assert.equal(new Set(shuffled).size, list3.length);
for (const item of list3) {
  assert.ok(shuffled.includes(item));
}

// 5. Default strategy is "random"
const defaultShuffled = applyRequestSelectionStrategy([...list3]);
assert.equal(defaultShuffled.length, list3.length);
assert.equal(new Set(defaultShuffled).size, list3.length);

console.log("request-selection-strategy tests passed successfully.");
