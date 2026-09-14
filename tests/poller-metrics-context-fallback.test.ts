import assert from "node:assert/strict";
import { Poller, type TeamPollerContext } from "../src/controllers/poller.js";
import { ApiClient } from "../src/services/api-client.js";
import { MetricsCollector, metrics } from "../src/services/metrics.js";

const base = { teamId: 91, teamName: "Synthetic Team", lineGroupId: "", manageHttpServer: false, manageProcessSignals: false, closeSharedResourcesOnStop: false, exitOnStop: false };
function internals(context?: TeamPollerContext) {
  return new Poller(undefined, context) as unknown as { metrics: MetricsCollector; apiClient: ApiClient };
}
// Constructor-only checks never start polling or make provider requests.
for (const apiClient of [undefined, null]) {
  const fallback = internals({ ...base, apiClient } as unknown as TeamPollerContext);
  assert.equal(fallback.metrics, metrics, "partial runtime contexts retain global collector fallback");
  assert.ok(fallback.apiClient instanceof ApiClient);
  assert.equal(fallback.apiClient.metricsCollector, metrics, "fallback client owns the selected collector");
}
assert.equal(internals().metrics, metrics);
const explicit = new MetricsCollector({ teamId: 91 });
const clientCollector = new MetricsCollector({ teamId: 92 });
const client = new ApiClient({ metricsCollector: clientCollector });
assert.equal(internals({ ...base, apiClient: client }).metrics, clientCollector, "injected client's collector precedes global fallback");
const selected = internals({ ...base, apiClient: client, metricsCollector: explicit });
assert.equal(selected.metrics, explicit, "explicit collector precedes injected client's collector");
assert.equal(selected.apiClient, client, "collector selection does not replace an injected client");
const created = internals({ ...base, apiClient: undefined, metricsCollector: explicit } as unknown as TeamPollerContext);
assert.equal(created.apiClient.metricsCollector, explicit);
console.log("poller-metrics-context-fallback: nullish fallback and explicit/client/global collector precedence passed");
