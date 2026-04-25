import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closePool, getPool } from "../db/client.js";

async function main(): Promise<void> {
  try {
    await runMigrations();
  } finally {
    await closePool();
  }
}

async function runMigrations(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY schema_migrations_name_idx (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const migrationsDir = resolve(process.cwd(), "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const [appliedRowsResult] = await pool.query("SELECT name FROM schema_migrations");
  const appliedRows = appliedRowsResult as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skip migration: ${file}`);
      continue;
    }

    const statements = splitSqlStatements(readFileSync(resolve(migrationsDir, file), "utf8"));
    if (statements.length === 0) {
      console.log(`Skip empty migration: ${file}`);
      continue;
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const statement of statements) {
        await connection.query(statement);
      }
      await connection.query("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
      await connection.commit();
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const previous = sql[i - 1];

    if ((char === '"' || char === "'" || char === "`") && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }

    if (char === ";" && quote === null) {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const statement = current.trim();
  if (statement) {
    statements.push(statement);
  }

  return statements;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
