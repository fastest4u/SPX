import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spxBookingHistoryMigrationSql } from "../db/migration-sql.js";

const migrationsDir = resolve(process.cwd(), "migrations");
const fileName = "001_create_booking_requests.sql";
const filePath = join(migrationsDir, fileName);

mkdirSync(migrationsDir, { recursive: true });
writeFileSync(filePath, spxBookingHistoryMigrationSql, "utf8");
console.log(`Generated migration: ${filePath}`);
