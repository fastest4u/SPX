import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import mysql from "mysql2/promise";

import { buildMysqlPoolOptions } from "../db/mysql-pool-options.js";

export const DEDICATED_N_MINUS_ONE_PROBE_TABLE = "spx_n_minus_one_probe_fixtures";

type ProbeRole =
  | "web-api"
  | "notification-service"
  | "line-service"
  | "ocr-service"
  | "worker-ifn-split"
  | "worker-ptwl-split";

interface RoleSpec {
  role: ProbeRole;
  runtimeRole: "api" | "notification-service" | "line-service" | "ocr-service" | "worker";
  nodeId: string;
  teamId: number | null;
  usesDatabase: boolean;
}

export type ValidatedProbeEnvironment = Readonly<RoleSpec>;

export interface NMinusOneProbeConnection {
  execute(statement: string, parameters?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
}

export interface NMinusOneRoleProbeResult {
  ok: true;
  role: ProbeRole;
  usesDatabase: boolean;
  dbCredentialPresent: boolean;
  connectAttempts: number;
  representativeReadPassed: boolean;
  representativeWritePassed: boolean;
  transactionRolledBack: boolean;
  fixtureHashUnchanged: boolean;
  fixtureRowCountUnchanged: boolean;
  ddlStatements: 0;
  providerCalls: 0;
  backgroundLoops: 0;
  liveClaims: 0;
  localBoundaryPassed: boolean;
}

const ROLE_BY_NODE = new Map<string, RoleSpec>([
  [
    "stg-n-minus-one-web-api",
    {
      role: "web-api",
      runtimeRole: "api",
      nodeId: "stg-n-minus-one-web-api",
      teamId: null,
      usesDatabase: true,
    },
  ],
  [
    "stg-n-minus-one-notification-service",
    {
      role: "notification-service",
      runtimeRole: "notification-service",
      nodeId: "stg-n-minus-one-notification-service",
      teamId: null,
      usesDatabase: true,
    },
  ],
  [
    "stg-n-minus-one-line-service",
    {
      role: "line-service",
      runtimeRole: "line-service",
      nodeId: "stg-n-minus-one-line-service",
      teamId: null,
      usesDatabase: true,
    },
  ],
  [
    "stg-n-minus-one-ocr-service",
    {
      role: "ocr-service",
      runtimeRole: "ocr-service",
      nodeId: "stg-n-minus-one-ocr-service",
      teamId: null,
      usesDatabase: false,
    },
  ],
  [
    "stg-n-minus-one-worker-ifn-split",
    {
      role: "worker-ifn-split",
      runtimeRole: "worker",
      nodeId: "stg-n-minus-one-worker-ifn-split",
      teamId: 2,
      usesDatabase: true,
    },
  ],
  [
    "stg-n-minus-one-worker-ptwl-split",
    {
      role: "worker-ptwl-split",
      runtimeRole: "worker",
      nodeId: "stg-n-minus-one-worker-ptwl-split",
      teamId: 1,
      usesDatabase: true,
    },
  ],
]);

const DISABLED_FLAGS = [
  "HTTP_ENABLED",
  "NOTIFY_ENABLED",
  "LINEJS_TEST_ENABLED",
  "AUTO_ACCEPT_ENABLED",
  "AUTO_ACCEPT_JOB_SHADOW_ENABLED",
  "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED",
  "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED",
] as const;

const PROVIDER_TARGETS = [
  "NOTIFIER_API_URL",
  "LINE_SERVICE_URL",
  "OCR_SERVICE_URL",
  "REALTIME_SERVICE_URL",
  "LINEJS_TEST_TARGET_ID",
  "LINE_USER_ID",
  "CODEX_IMAGE_PROVIDER",
] as const;

const DB_KEYS = [
  "DB_MODE",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USERNAME",
  "DB_PASSWORD",
  "DB_PASSWORD_FILE",
  "DB_SSL_MODE",
  "DB_SSL_CA_FILE",
  "DB_SSL_SERVERNAME",
] as const;

function stringValue(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertProviderBoundary(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  for (const key of PROVIDER_TARGETS) {
    if (stringValue(env[key]) !== "") throw new Error("provider boundary must remain disabled");
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      stringValue(value) !== "" &&
      key !== "DB_PASSWORD_FILE" &&
      (
        /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)(?:_FILE)?$/i.test(key) ||
        /^(?:LINE|OCR|NOTIFICATION|NOTIFIER|REALTIME|GATE6|CODEX)_.*(?:SECRET|TOKEN|KEY|URL|TARGET|PROVIDER)(?:_FILE)?$/i.test(key)
      )
    ) {
      throw new Error("provider or cross-role secret is forbidden in probe-only mode");
    }
  }
}

function assertDatabaseBoundary(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  usesDatabase: boolean,
): void {
  if (!usesDatabase) {
    if (DB_KEYS.some((key) => stringValue(env[key]) !== "")) {
      throw new Error("OCR probe database boundary is invalid");
    }
    return;
  }
  const port = Number(stringValue(env.DB_PORT));
  const host = stringValue(env.DB_HOST);
  const servername = stringValue(env.DB_SSL_SERVERNAME);
  if (
    stringValue(env.DB_MODE) !== "mysql" ||
    host !== "n-minus-one-db-proxy" ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    stringValue(env.DB_NAME) !== "spx_staging" ||
    stringValue(env.DB_USERNAME) === "" ||
    stringValue(env.DB_PASSWORD) !== "" ||
    stringValue(env.DB_PASSWORD_FILE) !== "/run/secrets/db_password" ||
    stringValue(env.DB_SSL_MODE) !== "verify-identity" ||
    stringValue(env.DB_SSL_CA_FILE) !== "/run/config/db-ca.pem" ||
    servername === "" ||
    servername === host
  ) {
    throw new Error("role database probe boundary is invalid");
  }
}

export function validateNMinusOneProbeEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ValidatedProbeEnvironment {
  if (stringValue(env.SPX_PROBE_ONLY) !== "true") {
    throw new Error("probe-only mode is required");
  }
  if (stringValue(env.SPX_ENVIRONMENT) !== "staging") {
    throw new Error("N-1 role probes are staging only");
  }
  for (const key of DISABLED_FLAGS) {
    if (stringValue(env[key]) !== "false") {
      throw new Error("all background and delivery flags must be disabled");
    }
  }
  assertProviderBoundary(env);
  const nodeId = stringValue(env.SPX_NODE_ID);
  const spec = ROLE_BY_NODE.get(nodeId);
  if (!spec || stringValue(env.SPX_ROLE) !== spec.runtimeRole) {
    throw new Error("probe role and node identity are invalid");
  }
  const teamIds = stringValue(env.RUN_TEAM_IDS);
  if ((spec.teamId === null && teamIds !== "") ||
      (spec.teamId !== null && teamIds !== String(spec.teamId))) {
    throw new Error("probe team identity is invalid");
  }
  assertDatabaseBoundary(env, spec.usesDatabase);
  return { ...spec };
}

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) throw new Error("dedicated probe fixture result is invalid");
  return result as Array<Record<string, unknown>>;
}

function fixtureValue(rows: Array<Record<string, unknown>>, role: ProbeRole): bigint {
  if (
    rows.length !== 1 ||
    rows[0]?.probe_role !== role ||
    !/^-?[0-9]+$/.test(String(rows[0]?.probe_value ?? ""))
  ) {
    throw new Error("dedicated probe fixture is unavailable");
  }
  return BigInt(String(rows[0].probe_value));
}

function fixtureHash(role: ProbeRole, value: bigint): string {
  return createHash("sha256").update(`${role}\0${value.toString()}`).digest("hex");
}

async function readFixture(
  connection: NMinusOneProbeConnection,
  role: ProbeRole,
  lock: boolean,
): Promise<{ count: number; value: bigint; hash: string }> {
  const statement =
    `SELECT probe_role, probe_value FROM ${DEDICATED_N_MINUS_ONE_PROBE_TABLE} ` +
    `WHERE probe_role = ?${lock ? " FOR UPDATE" : ""}`;
  const [result] = await connection.execute(statement, [role]);
  const rows = rowsFrom(result);
  const value = fixtureValue(rows, role);
  return { count: rows.length, value, hash: fixtureHash(role, value) };
}

function output(
  role: ProbeRole,
  overrides: Partial<NMinusOneRoleProbeResult>,
): NMinusOneRoleProbeResult {
  return {
    ok: true,
    role,
    usesDatabase: false,
    dbCredentialPresent: false,
    connectAttempts: 0,
    representativeReadPassed: false,
    representativeWritePassed: false,
    transactionRolledBack: false,
    fixtureHashUnchanged: true,
    fixtureRowCountUnchanged: true,
    ddlStatements: 0,
    providerCalls: 0,
    backgroundLoops: 0,
    liveClaims: 0,
    localBoundaryPassed: false,
    ...overrides,
  };
}

export async function executeNMinusOneRoleProbe(input: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  connect: (
    validated: ValidatedProbeEnvironment,
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => Promise<NMinusOneProbeConnection>;
}): Promise<NMinusOneRoleProbeResult> {
  const validated = validateNMinusOneProbeEnvironment(input.env);
  if (!validated.usesDatabase) {
    return output(validated.role, { localBoundaryPassed: true });
  }
  if (typeof input.connect !== "function") throw new Error("database probe connector is unavailable");
  const connection = await input.connect(validated, input.env);
  let transactionOpen = false;
  let transactionRolledBack = false;
  try {
    const before = await readFixture(connection, validated.role, false);
    await connection.beginTransaction();
    transactionOpen = true;
    const locked = await readFixture(connection, validated.role, true);
    if (locked.hash !== before.hash || locked.count !== before.count) {
      throw new Error("dedicated probe fixture changed before transaction");
    }
    const [updateResult] = await connection.execute(
      `UPDATE ${DEDICATED_N_MINUS_ONE_PROBE_TABLE} ` +
        "SET probe_value = probe_value + 1 WHERE probe_role = ?",
      [validated.role],
    );
    const affectedRows = (updateResult as { affectedRows?: unknown })?.affectedRows;
    if (affectedRows !== 1) throw new Error("dedicated probe fixture write did not affect one row");
    const changed = await readFixture(connection, validated.role, false);
    if (changed.value !== before.value + 1n || changed.count !== before.count) {
      throw new Error("dedicated probe fixture write could not be verified");
    }
    await connection.rollback();
    transactionOpen = false;
    transactionRolledBack = true;
    const after = await readFixture(connection, validated.role, false);
    if (after.hash !== before.hash || after.count !== before.count) {
      throw new Error("dedicated probe fixture changed after rollback");
    }
    return output(validated.role, {
      usesDatabase: true,
      dbCredentialPresent: true,
      connectAttempts: 1,
      representativeReadPassed: true,
      representativeWritePassed: true,
      transactionRolledBack,
      fixtureHashUnchanged: true,
      fixtureRowCountUnchanged: true,
    });
  } finally {
    if (transactionOpen) {
      await connection.rollback();
    }
    await connection.end();
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readDatabasePassword(path: string): string {
  if (path !== "/run/secrets/db_password") throw new Error("database credential path is invalid");
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size <= 0n || before.size > 65_536n) {
      throw new Error("database credential file is invalid");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("database credential file changed before read");
    }
    const buffer = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || !sameFileIdentity(opened, after)) {
      throw new Error("database credential file changed during read");
    }
    const value = buffer.toString("utf8").trim();
    if (value.length === 0 || value.includes("\0")) throw new Error("database credential is invalid");
    return value;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function connectLive(
  validated: ValidatedProbeEnvironment,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<NMinusOneProbeConnection> {
  if (!validated.usesDatabase) throw new Error("DB-free probe cannot connect");
  const password = readDatabasePassword(stringValue(env.DB_PASSWORD_FILE));
  const options = buildMysqlPoolOptions({
    host: stringValue(env.DB_HOST),
    port: Number(stringValue(env.DB_PORT)),
    user: stringValue(env.DB_USERNAME),
    password,
    database: stringValue(env.DB_NAME),
    sslMode: "verify-identity",
    sslCaFile: stringValue(env.DB_SSL_CA_FILE),
    sslServername: stringValue(env.DB_SSL_SERVERNAME),
  });
  const connection = await mysql.createConnection(options);
  return {
    execute: (statement, parameters = []) => connection.execute(statement, parameters as string[]),
    beginTransaction: () => connection.beginTransaction(),
    rollback: () => connection.rollback(),
    end: () => connection.end(),
  };
}

async function main(): Promise<void> {
  try {
    if (process.argv.length !== 2) throw new Error("caller arguments are forbidden");
    const result = await executeNMinusOneRoleProbe({ env: process.env, connect: connectLive });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write('{"failures":["N_MINUS_ONE_ROLE_PROBE_REJECTED"],"ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1]?.match(/phase4-n-minus-one-role-probe\.(?:ts|js)$/)) {
  void main();
}
