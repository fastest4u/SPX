import assert from "node:assert/strict";
import { rulesApi } from "../src/frontend/lib/api.ts";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return new Response(JSON.stringify({ status: "success", data: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

async function main() {
  try {
    // Dropping the admin-selected mode during preview understates the effect of activation.
    await rulesApi.preview(
      {
        teamId: 7,
        name: "Whole booking",
        origins: ["A"],
        destinations: ["B"],
        vehicle_types: [],
        need: 1,
        enabled: true,
        accept_all: true,
      },
      { ruleId: "existing-rule", limit: 200, sampleLimit: 8 },
    );
    const previewBody = JSON.parse(String(requests[0].init?.body));
    assert.equal(previewBody.rule.accept_all, true, "preview must carry whole-booking mode");
    assert.equal(previewBody.ruleId, "existing-rule", "edit review must bind to the existing rule");
    assert.equal(previewBody.rule.teamId, 7);

    requests.length = 0;
    await rulesApi.create({
      name: "Scoped review",
      origins: [],
      destinations: ["B"],
      vehicle_types: [],
      need: 1,
      enabled: true,
      accept_all: false,
      activationReview: { token: "synthetic-review-token", acknowledgeWildcard: true },
    });
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)).activationReview, {
      token: "synthetic-review-token",
      acknowledgeWildcard: true,
    });
    assert.equal(requests[0].url, "/api/rules");
    assert.equal(requests[0].init?.method, "POST");
    const { buildRuleInput, initialRuleValues, ruleReviewKey, activationReviewProblem } =
      await import("../src/frontend/lib/rule-review.ts");
    const normal = initialRuleValues();
    assert.equal(normal.enabled, false, "a new rule must begin disabled");
    const invalid = buildRuleInput({ ...normal, name: " ", needText: "1.5" }, { isAdmin: true });
    assert.ok(invalid.errors.name);
    assert.ok(invalid.errors.needText);
    assert.ok(invalid.errors.teamId);
    const existing = {
      id: "r1",
      teamId: 7,
      name: "All",
      origins: ["A"],
      destinations: ["B"],
      vehicle_types: [],
      need: 1,
      enabled: true,
      fulfilled: false,
      auto_accepted: false,
      auto_accept: true,
      accept_all: true,
    };
    const edited = buildRuleInput(
      { ...initialRuleValues(existing), acceptAll: false },
      { isAdmin: false, rule: existing },
    );
    assert.equal(
      edited.input?.accept_all,
      true,
      "non-admin editing must preserve an existing whole-booking mode",
    );
    const completed = buildRuleInput(
      { ...initialRuleValues(existing), needText: "0" },
      { isAdmin: false, rule: existing },
    );
    assert.equal(completed.input?.fulfilled, true);
    assert.equal(completed.input?.need, 0);
    const { disabledRulePatch } = await import("../src/frontend/lib/rule-review.ts");
    assert.deepEqual(
      disabledRulePatch({ ...edited.input!, enabled: false }, existing),
      { name: "All", enabled: false },
      "pausing must not resend unchanged progress",
    );
    assert.deepEqual(
      disabledRulePatch({ ...edited.input!, enabled: false, need: 4 }, existing),
      { name: "All", enabled: false, need: 4, fulfilled: false, auto_accepted: false },
      "a deliberately edited target must still be saved",
    );
    const input = edited.input!;
    const review = {
      token: "fixture",
      expiresAt: "2026-09-11T15:05:00Z",
      wildcardFields: ["vehicle_types"] as const,
      acceptAll: true,
    };
    const key = ruleReviewKey(input, "r1");
    const acknowledgements = { wildcard: true, acceptAll: true };
    const now = Date.parse("2026-09-11T15:00:00Z");
    assert.equal(activationReviewProblem(input, null, key, key, acknowledgements, now), "missing");
    assert.equal(activationReviewProblem(input, review, key, key, acknowledgements, now), null);
    assert.equal(
      activationReviewProblem(
        input,
        review,
        key,
        ruleReviewKey({ ...input, need: 2 }, "r1"),
        acknowledgements,
        now,
      ),
      "changed",
    );
    assert.equal(
      activationReviewProblem(input, review, key, key, acknowledgements, now + 300_000),
      "expired",
    );
    assert.equal(
      activationReviewProblem(input, review, key, key, { wildcard: false, acceptAll: true }, now),
      "wildcard",
    );
    assert.equal(
      activationReviewProblem(input, review, key, key, { wildcard: true, acceptAll: false }, now),
      "accept-all",
    );
    assert.equal(
      activationReviewProblem(
        { ...input, enabled: false },
        null,
        "",
        key,
        { wildcard: false, acceptAll: false },
        now,
      ),
      null,
      "disabling must never need a preview",
    );
    console.log("frontend-rule-review: API review contract passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
