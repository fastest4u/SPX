import assert from "node:assert/strict";
import { buildProviderDeliveryReadModel, type ProviderDeliveryReadModelRow } from "../src/services/provider-delivery-read-model.js";

async function testProviderDeliveryAggregationAndRedaction(): Promise<void> {
  const rows = [
    {
      provider: "linejs",
      status: "success",
      finishedAt: "2026-07-08T08:00:00.000Z",
      errorMessage: null,
    },
    {
      provider: "linejs",
      status: "success",
      finishedAt: new Date("2026-07-08T08:05:00.000Z"),
      errorMessage: null,
    },
    {
      provider: "linejs",
      status: "failed",
      finishedAt: "2026-07-08T08:10:00.000Z",
      errorMessage: "line target C123 rejected with token abc",
    },
    {
      provider: "linejs",
      status: "ambiguous",
      finishedAt: "2026-07-08T08:11:00.000Z",
      errorMessage: "provider outcome is unknown",
    },
    {
      provider: "linejs",
      status: "reconciled_success",
      finishedAt: "2026-07-08T08:12:00.000Z",
      errorMessage: null,
    },
    {
      provider: "linejs",
      status: "reconciled_not_sent",
      finishedAt: "2026-07-08T08:13:00.000Z",
      errorMessage: "OPERATOR_VERIFIED_NOT_SENT",
    },
    {
      provider: "linejs",
      status: "pending",
      finishedAt: "2026-07-08T08:15:00.000Z",
      errorMessage: "should be ignored",
    },
  ] satisfies ProviderDeliveryReadModelRow[];

  // @ts-expect-error providerMessageId is intentionally not part of the input interface.
  rows[0].providerMessageId = "provider-msg-1";

  const model = buildProviderDeliveryReadModel({
    rows,
    generatedAt: "2026-07-08T09:00:00.000Z",
    scope: { kind: "team", teamId: 42 },
    window: { from: "2026-07-07T09:00:00.000Z", to: "2026-07-08T09:00:00.000Z" },
  });

  assert.deepEqual(model, {
    generatedAt: "2026-07-08T09:00:00.000Z",
    scope: { kind: "team", teamId: 42 },
    window: { from: "2026-07-07T09:00:00.000Z", to: "2026-07-08T09:00:00.000Z" },
    providers: [
      {
        provider: "linejs",
        successCount: 3,
        failedCount: 2,
        ambiguousCount: 1,
        reconciledSuccessCount: 1,
        reconciledNotSentCount: 1,
        lastSuccessAt: "2026-07-08T08:12:00.000Z",
        lastFailureAt: "2026-07-08T08:13:00.000Z",
        lastErrorClass: "provider_error",
      },
    ],
  });

  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes("C123"), false);
  assert.equal(serialized.includes("token abc"), false);
  assert.equal(serialized.includes("line target C123 rejected with token abc"), false);
  assert.equal(serialized.includes("providerMessageId"), false);
}

async function main(): Promise<void> {
  await testProviderDeliveryAggregationAndRedaction();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
