import assert from "node:assert/strict";
import { MetricsCollector, teamMetricsCollector } from "../src/services/metrics.js";
import { normalizeRuntimeMetricsSnapshot, recordRuntimeMetricsSnapshot, runtimeMetricsSnapshotFor, clearRuntimeMetricsSnapshots } from "../src/services/runtime-metrics.js";
const stages = ['biddingListPage1', 'page1ToDetailStart', 'firstMatchToAcceptStart', 'verificationQueueWait'] as const;
const old = new MetricsCollector({teamId: 9}).snapshot();
for (const stage of stages) delete (old.operations as Record<string, unknown>)[stage];
const normalized = normalizeRuntimeMetricsSnapshot(old);
for (const stage of stages) assert.deepEqual(normalized.operations[stage], {count:0,avg:0,min:0,max:0,p50:0,p95:0,p99:0,lastMs:null});
assert.throws(() => normalizeRuntimeMetricsSnapshot({...old, operations:{...old.operations, biddingListPage1: {count:NaN}}}));
const missingRequired = structuredClone(old);
delete (missingRequired.operations as Record<string, unknown>).acceptRtt;
assert.throws(() => normalizeRuntimeMetricsSnapshot(missingRequired));
const one = new MetricsCollector({teamId: 31}); const two = new MetricsCollector({teamId: 32});
for (const stage of stages) { one.recordOperation(stage, 100); one.recordOperation(stage, 200); two.recordOperation(stage, 600); }
clearRuntimeMetricsSnapshots();
for (const collector of [one, two]) recordRuntimeMetricsSnapshot({nodeId: 'synthetic', snapshot: collector.snapshot()});
teamMetricsCollector(31).recordOperation('firstMatchToAcceptStart', 9999);
for (const stage of stages) {
 assert.equal(runtimeMetricsSnapshotFor(old,31).operations[stage].avg,150);
 assert.equal(runtimeMetricsSnapshotFor(old,32).operations[stage].avg,600);
 assert.equal(runtimeMetricsSnapshotFor(old,null).operations[stage].avg,300);
 assert.equal(runtimeMetricsSnapshotFor(old,null).operations[stage].count,3);
}
console.log('runtime-metrics-stage-compat: legacy normalization and weighted scope assertions passed');
