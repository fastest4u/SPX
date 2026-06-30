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
  appSettingsMigrationSql,
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
  appSettingsMigrationSql,
].join("\n\n");

mkdirSync(migrationsDir, { recursive: true });
writeFileSync(filePath, allMigrations, "utf8");
console.log(`Generated migration: ${filePath}`);
