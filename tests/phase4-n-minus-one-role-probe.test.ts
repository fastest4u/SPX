import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEDICATED_N_MINUS_ONE_PROBE_TABLE,
  executeNMinusOneRoleProbe,
  validateNMinusOneProbeEnvironment,
} from "../src/scripts/phase4-n-minus-one-role-probe.js";

const disabled = {
  SPX_PROBE_ONLY: "true",
  SPX_ENVIRONMENT: "staging",
  HTTP_ENABLED: "false",
  NOTIFY_ENABLED: "false",
  LINEJS_TEST_ENABLED: "false",
  AUTO_ACCEPT_ENABLED: "false",
  AUTO_ACCEPT_JOB_SHADOW_ENABLED: "false",
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: "false",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "false",
  NOTIFIER_API_URL: "",
  LINE_SERVICE_URL: "",
  OCR_SERVICE_URL: "",
  REALTIME_SERVICE_URL: "",
};

const database = {
  DB_MODE: "mysql",
  DB_HOST: "n-minus-one-db-proxy",
  DB_PORT: "3306",
  DB_NAME: "spx_staging",
  DB_USERNAME: "role-bound-user",
  DB_PASSWORD_FILE: "/run/secrets/db_password",
  DB_SSL_MODE: "verify-identity",
  DB_SSL_CA_FILE: "/run/config/db-ca.pem",
  DB_SSL_SERVERNAME: "staging-db.internal",
};

const webEnv = {
  ...disabled,
  ...database,
  SPX_ROLE: "api",
  SPX_NODE_ID: "stg-n-minus-one-web-api",
  RUN_TEAM_IDS: "",
};

class ProbeConnection {
  readonly sql: string[] = [];
  began = 0;
  rolledBack = 0;
  ended = 0;
  private transactionValue: bigint | null = null;
  private readonly committedValue = 7n;

  async execute(statement: string, parameters: unknown[] = []): Promise<[unknown, unknown]> {
    this.sql.push(statement);
    assert.deepEqual(parameters, ["web-api"]);
    assert.match(statement, new RegExp(DEDICATED_N_MINUS_ONE_PROBE_TABLE));
    if (/^\s*UPDATE\b/i.test(statement)) {
      assert.notEqual(this.transactionValue, null);
      this.transactionValue = this.transactionValue! + 1n;
      return [{ affectedRows: 1 }, []];
    }
    const value = this.transactionValue ?? this.committedValue;
    return [[{ probe_role: "web-api", probe_value: value.toString() }], []];
  }

  async beginTransaction(): Promise<void> {
    this.began += 1;
    this.transactionValue = this.committedValue;
  }

  async rollback(): Promise<void> {
    this.rolledBack += 1;
    this.transactionValue = null;
  }

  async end(): Promise<void> {
    this.ended += 1;
  }
}

async function main(): Promise<void> {
  const roleCases = [
    ["web-api", "api", "stg-n-minus-one-web-api", "", true],
    [
      "notification-service",
      "notification-service",
      "stg-n-minus-one-notification-service",
      "",
      true,
    ],
    ["line-service", "line-service", "stg-n-minus-one-line-service", "", true],
    ["ocr-service", "ocr-service", "stg-n-minus-one-ocr-service", "", false],
    ["worker-ifn-split", "worker", "stg-n-minus-one-worker-ifn-split", "2", true],
    ["worker-ptwl-split", "worker", "stg-n-minus-one-worker-ptwl-split", "1", true],
  ] as const;
  for (const [role, runtimeRole, nodeId, teamIds, usesDatabase] of roleCases) {
    assert.deepEqual(
      validateNMinusOneProbeEnvironment({
        ...disabled,
        ...(usesDatabase ? database : {}),
        SPX_ROLE: runtimeRole,
        SPX_NODE_ID: nodeId,
        RUN_TEAM_IDS: teamIds,
      }),
      {
        role,
        runtimeRole,
        nodeId,
        teamId: teamIds === "" ? null : Number(teamIds),
        usesDatabase,
      },
    );
  }

  assert.deepEqual(validateNMinusOneProbeEnvironment(webEnv), {
    role: "web-api",
    runtimeRole: "api",
    nodeId: "stg-n-minus-one-web-api",
    teamId: null,
    usesDatabase: true,
  });
  assert.deepEqual(
    validateNMinusOneProbeEnvironment({
      ...disabled,
      SPX_ROLE: "worker",
      SPX_NODE_ID: "stg-n-minus-one-worker-ifn-split",
      RUN_TEAM_IDS: "2",
      ...database,
    }).role,
    "worker-ifn-split",
  );
  assert.throws(
    () => validateNMinusOneProbeEnvironment({ ...webEnv, SPX_PROBE_ONLY: "false" }),
    /probe-only|probe only/i,
  );
  assert.throws(
    () => validateNMinusOneProbeEnvironment({ ...webEnv, DB_HOST: "staging-db.internal" }),
    /proxy|database.*boundary/i,
  );
  assert.throws(
    () => validateNMinusOneProbeEnvironment({ ...webEnv, LINE_SERVICE_URL: "https://provider.example" }),
    /provider|boundary/i,
  );
  assert.throws(
    () => validateNMinusOneProbeEnvironment({ ...webEnv, OCR_NODE_SECRET: "must-not-be-present" }),
    /secret|provider|boundary/i,
  );
  assert.throws(
    () => validateNMinusOneProbeEnvironment({
      ...webEnv,
      GATE6_LINE_PERMIT_PUBLIC_KEY_FILE: "/run/secrets/provider-key",
    }),
    /secret|provider|boundary/i,
  );

  const connection = new ProbeConnection();
  let connections = 0;
  const result = await executeNMinusOneRoleProbe({
    env: webEnv,
    connect: async () => {
      connections += 1;
      return connection;
    },
  });
  assert.deepEqual(result, {
    ok: true,
    role: "web-api",
    usesDatabase: true,
    dbCredentialPresent: true,
    connectAttempts: 1,
    representativeReadPassed: true,
    representativeWritePassed: true,
    transactionRolledBack: true,
    fixtureHashUnchanged: true,
    fixtureRowCountUnchanged: true,
    ddlStatements: 0,
    providerCalls: 0,
    backgroundLoops: 0,
    liveClaims: 0,
    localBoundaryPassed: false,
  });
  assert.equal(connections, 1);
  assert.equal(connection.began, 1);
  assert.equal(connection.rolledBack, 1);
  assert.equal(connection.ended, 1);
  assert.equal(connection.sql.some((sql) => /^\s*UPDATE\b/i.test(sql)), true);
  assert.equal(connection.sql.every((sql) => !/\b(?:CREATE|ALTER|DROP|TRUNCATE|REPLACE|INSERT|DELETE)\b/i.test(sql)), true);

  let ocrConnections = 0;
  const ocr = await executeNMinusOneRoleProbe({
    env: {
      ...disabled,
      SPX_ROLE: "ocr-service",
      SPX_NODE_ID: "stg-n-minus-one-ocr-service",
      RUN_TEAM_IDS: "",
    },
    connect: async () => {
      ocrConnections += 1;
      throw new Error("must not connect");
    },
  });
  assert.deepEqual(ocr, {
    ok: true,
    role: "ocr-service",
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
    localBoundaryPassed: true,
  });
  assert.equal(ocrConnections, 0);
  assert.throws(
    () => validateNMinusOneProbeEnvironment({
      ...disabled,
      ...database,
      SPX_ROLE: "ocr-service",
      SPX_NODE_ID: "stg-n-minus-one-ocr-service",
      RUN_TEAM_IDS: "",
    }),
    /database|OCR/i,
  );

  const source = readFileSync("src/scripts/phase4-n-minus-one-role-probe.ts", "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:app|notify|line|ocr|poller|worker)[^"']*["']/i);
  assert.doesNotMatch(source, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i);
  for (const businessTable of [
    "teams",
    "app_settings",
    "notification_outbox",
    "notification_deliveries",
    "line_image_extractions",
    "auto_accept_jobs",
    "spx_booking_history",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${businessTable}\\b`, "i"));
  }

  console.log("Phase 4 N-1 role probe tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
