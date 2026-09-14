import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { notificationOutbox } from "../src/db/schema.js";

const drizzleColumns = notificationOutbox as unknown as Record<string, { name?: string }>;
assert.equal(drizzleColumns.providerRequestId?.name, "provider_request_id");
assert.equal(drizzleColumns.providerStartedAt?.name, "provider_started_at");

resetMemoryDb();
const memoryColumns = getRawMemoryDb()
  .prepare("PRAGMA table_info(notification_outbox)")
  .all() as Array<{ name: string }>;
const memoryColumnNames = new Set(memoryColumns.map((column) => column.name));
assert.equal(memoryColumnNames.has("provider_request_id"), true);
assert.equal(memoryColumnNames.has("provider_started_at"), true);

const migration = readFileSync(
  resolve(process.cwd(), "migrations", "032_add_notification_provider_delivery_fence.sql"),
  "utf8",
);
for (const columnName of ["provider_request_id", "provider_started_at"]) {
  assert.match(migration, new RegExp(`COLUMN_NAME\\s*=\\s*'${columnName}'`, "i"));
  assert.match(migration, new RegExp(`ADD COLUMN ${columnName}`, "i"));
}

const mysqlRuntimeDdl = readFileSync(resolve(process.cwd(), "src", "db", "client.ts"), "utf8");
for (const columnName of ["provider_request_id", "provider_started_at"]) {
  assert.match(mysqlRuntimeDdl, new RegExp(`notification_outbox.*${columnName}`, "is"));
}

console.log("notification-provider-delivery-fence-schema: durable provider fence columns verified");
