import assert from "node:assert/strict";
import {
  ALL_HISTORY_FILTER_VALUE,
  buildHistoryTeamOptions,
  buildHistoryVehicleOptions,
  historyTeamIdFromFilter,
  historyVehicleTypeFromFilter,
} from "../src/frontend/lib/history-filters.js";

const teams = [
  { id: 2, name: "Beta Ops" },
  { id: 1, name: "Alpha Ops" },
];

assert.deepEqual(buildHistoryTeamOptions(teams), [
  { value: ALL_HISTORY_FILTER_VALUE, label: "ทุกทีม" },
  { value: "1", label: "Alpha Ops" },
  { value: "2", label: "Beta Ops" },
]);

assert.deepEqual(
  buildHistoryVehicleOptions(["6W", "", "4W", " 6W ", "4W"]),
  [
    { value: ALL_HISTORY_FILTER_VALUE, label: "ทุกประเภท" },
    { value: "4W", label: "4W" },
    { value: "6W", label: "6W" },
  ],
);

assert.equal(historyTeamIdFromFilter(ALL_HISTORY_FILTER_VALUE), undefined);
assert.equal(historyTeamIdFromFilter("2"), 2);
assert.equal(historyTeamIdFromFilter("not-a-team"), undefined);

assert.equal(historyVehicleTypeFromFilter(ALL_HISTORY_FILTER_VALUE), undefined);
assert.equal(historyVehicleTypeFromFilter(" 6W "), "6W");
assert.equal(historyVehicleTypeFromFilter(""), undefined);

console.log("frontend-history-filters: all assertions passed");
