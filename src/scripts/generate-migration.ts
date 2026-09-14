import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  teamsMigrationSql,
  spxBookingHistoryMigrationSql,
  notifyRulesMigrationSql,
  autoAcceptHistoryMigrationSql,
  metricsSnapshotsMigrationSql,
  lineBotSessionsMigrationSql,
  lineImageExtractionsMigrationSql,
  notificationEventsMigrationSql,
  notificationOutboxMigrationSql,
  notificationDeliveriesMigrationSql,
  runtimeNodesMigrationSql,
  teamRuntimeLeasesMigrationSql,
  teamRuntimeDesiredStateMigrationSql,
  autoAcceptAttemptsMigrationSql,
  autoAcceptResultsMigrationSql,
  autoAcceptVerificationJobsMigrationSql,
  appSettingsMigrationSql,
  internalRequestReplaysMigrationSql,
} from "../db/migration-sql.js";

const migrationsDir = resolve(process.cwd(), "migrations");
const fileName = "001_create_booking_requests.sql";
const filePath = join(migrationsDir, fileName);

const allMigrations = [
  teamsMigrationSql,
  spxBookingHistoryMigrationSql,
  notifyRulesMigrationSql,
  autoAcceptHistoryMigrationSql,
  metricsSnapshotsMigrationSql,
  lineBotSessionsMigrationSql,
  lineImageExtractionsMigrationSql,
  notificationEventsMigrationSql,
  notificationOutboxMigrationSql,
  notificationDeliveriesMigrationSql,
  runtimeNodesMigrationSql,
  teamRuntimeLeasesMigrationSql,
  teamRuntimeDesiredStateMigrationSql,
  autoAcceptAttemptsMigrationSql,
  autoAcceptResultsMigrationSql,
  autoAcceptVerificationJobsMigrationSql,
  appSettingsMigrationSql,
  internalRequestReplaysMigrationSql,
].join("\n\n");

mkdirSync(migrationsDir, { recursive: true });
// Applied SQL is append-only. Exclusive creation also closes the check/write race.
try {
  writeFileSync(filePath, allMigrations, { encoding: "utf8", flag: "wx" });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    throw new Error("Refusing to overwrite an existing migration; add a new numbered migration instead.");
  }
  throw error;
}
console.log(`Generated migration: ${filePath}`);
