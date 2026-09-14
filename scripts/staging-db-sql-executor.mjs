#!/usr/bin/env node

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.:-]*[A-Za-z0-9])?$/;
const ALLOWED_SQL = /^(?:CREATE DATABASE IF NOT EXISTS|CREATE USER IF NOT EXISTS|GRANT |DROP USER IF EXISTS)/;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function validateStagingSqlPayload(value) {
  if (!exactKeys(value, ["schemaVersion", "connection", "statements"]) || value.schemaVersion !== 1) {
    throw new Error("staging SQL payload has an unknown or missing field");
  }
  const connection = value.connection;
  if (
    !exactKeys(connection, ["host", "port", "user", "password", "database", "ssl"]) ||
    !HOST.test(connection.host ?? "") ||
    !Number.isSafeInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535 ||
    connection.user !== "spx_staging_bootstrap" ||
    typeof connection.password !== "string" ||
    connection.password.length < 32 ||
    connection.password.length > 4_096 ||
    connection.password.trim() !== connection.password ||
    /[\r\n\0]/.test(connection.password) ||
    connection.database !== "spx_staging" ||
    !exactKeys(connection.ssl, ["ca", "rejectUnauthorized", "servername"]) ||
    typeof connection.ssl.ca !== "string" ||
    connection.ssl.ca.length < 1 ||
    connection.ssl.ca.length > 256 * 1024 ||
    connection.ssl.rejectUnauthorized !== true ||
    !HOST.test(connection.ssl.servername ?? "")
  ) {
    throw new Error("staging SQL connection capability is invalid");
  }
  if (
    !Array.isArray(value.statements) ||
    value.statements.length < 1 ||
    value.statements.length > 2_048
  ) {
    throw new Error("staging SQL statement set is invalid");
  }
  for (const statement of value.statements) {
    if (
      !exactKeys(statement, ["sql", "parameters"]) ||
      typeof statement.sql !== "string" ||
      statement.sql.length < 1 ||
      statement.sql.length > 64 * 1024 ||
      !ALLOWED_SQL.test(statement.sql) ||
      /[;\0]/.test(statement.sql) ||
      !Array.isArray(statement.parameters) ||
      statement.parameters.length > 1 ||
      statement.parameters.some(
        (parameter) =>
          typeof parameter !== "string" ||
          parameter.length < 32 ||
          parameter.length > 4_096 ||
          parameter.trim() !== parameter ||
          /[\r\n\0]/.test(parameter),
      )
    ) {
      throw new Error("staging SQL statement is outside the reviewed provision grammar");
    }
  }
  return value;
}

export async function executeStagingSqlPayload(value, mysql) {
  const payload = validateStagingSqlPayload(value);
  if (!mysql || typeof mysql.createConnection !== "function") {
    throw new Error("candidate MySQL client is unavailable");
  }
  const connection = await mysql.createConnection({
    ...payload.connection,
    database: undefined,
  });
  try {
    for (const statement of payload.statements) {
      await connection.query(statement.sql, statement.parameters);
    }
  } finally {
    await connection.end();
  }
  return { ok: true, statementCount: payload.statements.length };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("staging SQL payload is too large");
    chunks.push(chunk);
  }
  if (size < 2) throw new Error("staging SQL payload is missing");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  if (process.argv.length !== 2) throw new Error("staging SQL executor accepts zero arguments");
  const mysql = await import("mysql2/promise");
  await executeStagingSqlPayload(await readStdin(), mysql);
  process.stdout.write('{"ok":true}\n');
}

if (process.argv[1]?.endsWith("staging-db-sql-executor.mjs")) {
  main().catch(() => {
    process.stdout.write('{"ok":false,"code":"staging-sql-refused"}\n');
    process.exitCode = 1;
  });
}
