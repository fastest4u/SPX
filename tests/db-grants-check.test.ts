import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "ALTER" | "INDEX" | "DROP";

interface GrantRoleContract {
  composePrincipalEnv: string;
  composeService: string | null;
  principalType: "compose" | "controller" | "observer";
  runtimeDdlFree: boolean;
  schemaPrivileges: Privilege[];
  tables: Record<string, Privilege[]>;
  columns: Record<string, Partial<Record<Privilege, string[]>>>;
}

interface GrantContract {
  accountHostInput: {
    cliOption: string;
    fileEnvironment: string;
  };
  accountResourceLimits: Record<string, { maxUserConnections: number }>;
  schemaVersion: number;
  roles: Record<string, GrantRoleContract>;
}

interface GrantEvidence {
  account: string;
  currentRole: string;
  database: string;
  userPrivileges: Array<{ privilegeType: string; isGrantable: string }>;
  schemaPrivileges: Array<{ tableSchema: string; privilegeType: string; isGrantable: string }>;
  tablePrivileges: Array<{
    tableSchema: string;
    tableName: string;
    privilegeType: string;
    isGrantable: string;
  }>;
  columnPrivileges: Array<{
    tableSchema: string;
    tableName: string;
    columnName: string;
    privilegeType: string;
    isGrantable: string;
  }>;
  routinePrivileges: unknown[];
  showGrants: string[];
}

const root = process.cwd();
const contractPath = resolve(root, "deploy/db-grants.json");
const scriptPath = resolve(root, "scripts/db-grants-check.mjs");
const sensitive = "sensitive-db-grant-secret-material";

function evidenceFor(
  role: GrantRoleContract,
  database = "spx_prod",
): GrantEvidence {
  return {
    account: "spx_service@10.%",
    currentRole: "NONE",
    database,
    userPrivileges: [],
    schemaPrivileges: role.schemaPrivileges.map((privilegeType) => ({
      tableSchema: database,
      privilegeType,
      isGrantable: "NO",
    })),
    tablePrivileges: Object.entries(role.tables).flatMap(([tableName, privileges]) =>
      privileges.map((privilegeType) => ({
        tableSchema: database,
        tableName,
        privilegeType,
        isGrantable: "NO",
      })),
    ),
    columnPrivileges: Object.entries(role.columns).flatMap(([tableName, grants]) =>
      Object.entries(grants).flatMap(([privilegeType, columns]) =>
        (columns ?? []).map((columnName) => ({
          tableSchema: database,
          tableName,
          columnName,
          privilegeType,
          isGrantable: "NO",
        })),
      ),
    ),
    routinePrivileges: [],
    showGrants: ["GRANT USAGE ON *.* TO `spx_service`@`10.%` REQUIRE SSL"],
  };
}

async function main(): Promise<void> {
  const grantModule = await import("../scripts/db-grants-check.mjs") as {
    canonicalGrantContractJson(value: unknown): string;
    collectGrantEvidence(connection: {
      query(sql: string, values?: unknown[]): Promise<[unknown[], unknown]>;
    }): Promise<GrantEvidence>;
    evaluateGrantEvidence(
      contract: GrantContract,
      role: string,
      expectedUsername: string,
      expectedAccountHost: string,
      evidence: GrantEvidence,
    ): { ok: boolean; failureCodes: string[] };
    evaluateContractRoleReadiness(
      contract: GrantContract,
      role: string,
    ): { ok: boolean; failureCodes: string[] };
    loadGrantContract(path: string): GrantContract;
  };

  const contract = grantModule.loadGrantContract(contractPath);
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.accountHostInput, {
    cliOption: "--expected-account-host",
    fileEnvironment: "DB_EXPECTED_ACCOUNT_HOST_FILE",
  });
  assert.deepEqual(contract.accountResourceLimits, {
    "gate6-monitor": { maxUserConnections: 1 },
  });
  assert.deepEqual(Object.keys(contract.roles), [
    "auto-accept-ifn-phase3",
    "auto-accept-ptwl-phase3",
    "gate6-control",
    "gate6-monitor",
    "line-service",
    "migrator",
    "notification-service",
    "observer",
    "phase3-control",
    "phase3-observer",
    "poller-ifn-phase3",
    "poller-ptwl-phase3",
    "realtime-service",
    "web-api",
    "worker-ifn-split",
    "worker-ptwl-split",
  ]);
  assert.equal(
    readFileSync(contractPath, "utf8"),
    grantModule.canonicalGrantContractJson(contract),
    "grant contract must use deterministic canonical JSON",
  );

  const runtimeRoles = Object.entries(contract.roles)
    .filter(([name]) => name !== "migrator");
  for (const [name, role] of runtimeRoles) {
    assert.equal(role.runtimeDdlFree, true, `${name} must pass the runtime DDL gate`);
    assert.deepEqual(role.schemaPrivileges, [], `${name} must not have schema privileges`);
    if (!new Set(["gate6-control", "gate6-monitor", "observer"]).has(name)) {
      assert.deepEqual(
        role.tables.schema_migrations,
        ["SELECT"],
        `${name} must verify released migration history at startup`,
      );
    }
    assert.equal(
      [
        ...Object.values(role.tables).flat(),
        ...Object.values(role.columns).flatMap((grants) => Object.keys(grants)),
      ].some((privilege) =>
        ["CREATE", "ALTER", "INDEX", "DROP"].includes(privilege)),
      false,
      `${name} must not have table DDL privileges`,
    );
  }
  assert.deepEqual(contract.roles.migrator.schemaPrivileges, [
    "SELECT",
    "INSERT",
    "UPDATE",
    "CREATE",
    "ALTER",
    "INDEX",
    "DROP",
  ]);
  assert.equal("ocr-service" in contract.roles, false, "OCR must remain DB-free");

  const phase3RuntimeRoles = [
    "poller-ifn-phase3",
    "auto-accept-ifn-phase3",
    "poller-ptwl-phase3",
    "auto-accept-ptwl-phase3",
  ] as const;
  for (const roleName of phase3RuntimeRoles) {
    const role = contract.roles[roleName]!;
    assert.equal(role.principalType, "compose");
    assert.equal(typeof role.composeService, "string");
    assert.equal(
      Object.entries(role.tables).filter(([table]) => table !== "realtime_execution_metrics" || !roleName.startsWith("auto-accept-")).flatMap(([, privileges]) => privileges).includes("DELETE")
        || Object.values(role.columns).some((grants) => "DELETE" in grants),
      false,
      `${roleName} must not have DELETE outside the execution telemetry retention table`,
    );
  }
  assert.equal(contract.roles["phase3-control"]?.principalType, "controller");
  assert.equal(contract.roles["phase3-control"]?.composeService, null);
  assert.equal(contract.roles["phase3-observer"]?.principalType, "observer");
  assert.equal(contract.roles["phase3-observer"]?.composeService, null);
  assert.deepEqual(contract.roles["phase3-observer"]?.tables, {
    operational_phase3_control_evidence: ["SELECT"],
    operational_phase3_evidence: ["SELECT"],
    schema_migrations: ["SELECT"],
  });
  assert.deepEqual(contract.roles["phase3-observer"]?.columns, {
    auto_accept_attempts: {
      SELECT: [
        "accept_finished_at", "ambiguous_accept", "created_at", "id",
        "team_id", "trace_id", "worker_node_id",
      ],
    },
    auto_accept_history: {
      SELECT: ["booking_id", "rule_id", "team_id", "trace_id"],
    },
    auto_accept_job_settlements: {
      SELECT: ["completed_at", "job_id", "settlement_step", "team_id"],
    },
    auto_accept_jobs: {
      SELECT: [
        "booking_id", "claim_expires_at", "completed_at", "created_at",
        "cutover_epoch", "id", "publication_generation", "request_id",
        "result_status", "rule_id", "status", "team_id",
        "winning_attempt_trace_id",
      ],
    },
    auto_accept_results: {
      SELECT: ["booking_id", "request_id", "team_id"],
    },
    notification_events: {
      SELECT: ["event_type", "team_id", "trace_id"],
    },
    spx_booking_history: {
      SELECT: ["request_id", "team_id"],
    },
    team_runtime_leases: {
      SELECT: ["lease_expires_at", "owner_node_id", "status", "team_id"],
    },
  });
  assert.deepEqual(contract.roles["gate6-control"], {
    columns: {},
    composePrincipalEnv: "SPX_DB_USERNAME_GATE6_CONTROL",
    composeService: "gate6-control",
    principalType: "compose",
    runtimeDdlFree: true,
    schemaPrivileges: [],
    tables: {
      gate6_actions: ["SELECT", "INSERT", "UPDATE"],
      gate6_environment_slots: ["SELECT", "INSERT", "UPDATE"],
      gate6_fault_permits: ["SELECT", "INSERT", "UPDATE"],
      gate6_runs: ["SELECT", "INSERT", "UPDATE"],
    },
  });
  assert.deepEqual(contract.roles["gate6-monitor"], {
    columns: {},
    composePrincipalEnv: "SPX_DB_USERNAME_GATE6_MONITOR",
    composeService: "gate6-monitor-probe",
    principalType: "compose",
    runtimeDdlFree: true,
    schemaPrivileges: [],
    tables: {
      auto_accept_jobs: ["SELECT"],
      notification_outbox: ["SELECT"],
      team_runtime_leases: ["SELECT"],
    },
  });
  assert.deepEqual(contract.roles.observer, {
    columns: {},
    composePrincipalEnv: "SPX_DB_USERNAME_GATE6_OBSERVER",
    composeService: null,
    principalType: "observer",
    runtimeDdlFree: true,
    schemaPrivileges: [],
    tables: { operational_gate6_terminal_evidence: ["SELECT"] },
  });

  const immutableColumns = new Set([
    "team_id",
    "cutover_epoch",
    "publication_generation",
    "created_at",
  ]);
  for (const roleName of [...phase3RuntimeRoles, "phase3-control"] as const) {
    const role = contract.roles[roleName]!;
    for (const [tableName, grants] of Object.entries(role.columns)) {
      for (const column of grants.UPDATE ?? []) {
        assert.equal(
          immutableColumns.has(column),
          false,
          `${roleName} must not update immutable ${tableName}.${column}`,
        );
      }
    }
  }

  const phase3Control = contract.roles["phase3-control"]!;
  assert.deepEqual(phase3Control.tables.auto_accept_publication_controls, ["SELECT", "INSERT"]);
  assert.deepEqual(phase3Control.tables.auto_accept_publication_active_epochs, ["SELECT", "INSERT"]);
  assert.deepEqual(
    phase3Control.columns.auto_accept_publication_active_epochs?.UPDATE,
    ["active_epoch", "active_generation", "updated_at"],
  );
  assert.equal(phase3Control.tables.auto_accept_jobs, undefined, "controller job reads must be column-scoped");
  assert.deepEqual(
    phase3Control.columns.auto_accept_jobs?.UPDATE,
    [
      "claim_expires_at",
      "claim_owner",
      "claim_token",
      "claimed_at",
      "completed_at",
      "last_heartbeat_at",
      "last_reason_code",
      "status",
      "updated_at",
    ],
  );

  const unresolvedContract = structuredClone(contract);
  unresolvedContract.roles["web-api"]!.runtimeDdlFree = false;
  assert.deepEqual(
    grantModule.evaluateContractRoleReadiness(unresolvedContract, "web-api"),
    { ok: false, failureCodes: ["runtime_ddl_dependency_unresolved"] },
  );

  for (const roleName of ["line-service", "notification-service", "realtime-service", "web-api"]) {
    assert.deepEqual(
      contract.roles[roleName]?.tables.internal_request_replays,
      ["SELECT", "INSERT", "DELETE"],
      `${roleName} must have the exact durable replay grant`,
    );
  }
  assert.deepEqual(contract.roles["line-service"]?.tables.line_bot_sessions, [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
  ]);
  assert.equal(
    contract.roles["web-api"]?.tables.line_bot_sessions,
    undefined,
    "split web-api must not read line-service authentication state",
  );
  for (const roleName of ["worker-ifn-split", "worker-ptwl-split"]) {
    assert.equal(
      contract.roles[roleName]?.tables.internal_request_replays,
      undefined,
      `${roleName} has no inbound signed HTTP replay boundary`,
    );
  }

  const lineRole = contract.roles["line-service"];
  const allowed = evidenceFor(lineRole);
  assert.deepEqual(
    grantModule.evaluateGrantEvidence(contract, "line-service", "spx_service", "10.%", allowed),
    { ok: true, failureCodes: [] },
  );

  const phase3ControlAllowed = evidenceFor(phase3Control);
  assert.deepEqual(
    grantModule.evaluateGrantEvidence(
      contract,
      "phase3-control",
      "spx_service",
      "10.%",
      phase3ControlAllowed,
    ),
    { ok: true, failureCodes: [] },
  );
  const missingControlColumn = structuredClone(phase3ControlAllowed);
  missingControlColumn.columnPrivileges = missingControlColumn.columnPrivileges.slice(1);
  assert.equal(
    grantModule.evaluateGrantEvidence(
      contract,
      "phase3-control",
      "spx_service",
      "10.%",
      missingControlColumn,
    ).failureCodes.includes("required_privilege_missing"),
    true,
  );

  const phase3Observer = contract.roles["phase3-observer"]!;
  const phase3ObserverAllowed = evidenceFor(phase3Observer);
  assert.deepEqual(
    grantModule.evaluateGrantEvidence(
      contract,
      "phase3-observer",
      "spx_service",
      "10.%",
      phase3ObserverAllowed,
    ),
    { ok: true, failureCodes: [] },
  );
  const requiredObserverColumns = Object.entries(phase3Observer.columns).flatMap(
    ([tableName, grants]) => grants.SELECT.map((columnName) => ({ tableName, columnName })),
  );
  for (const { tableName, columnName } of requiredObserverColumns) {
    const missingObserverColumn = structuredClone(phase3ObserverAllowed);
    missingObserverColumn.columnPrivileges = missingObserverColumn.columnPrivileges.filter(
      (row) => row.tableName !== tableName || row.columnName !== columnName,
    );
    assert.equal(
      grantModule.evaluateGrantEvidence(
        contract,
        "phase3-observer",
        "spx_service",
        "10.%",
        missingObserverColumn,
      ).failureCodes.includes("required_privilege_missing"),
      true,
      `${tableName}.${columnName}`,
    );
  }
  for (const mutate of [
    (evidence: GrantEvidence) => evidence.tablePrivileges.push({
      tableSchema: "spx_prod",
      tableName: "team_runtime_leases",
      privilegeType: "SELECT",
      isGrantable: "NO",
    }),
    (evidence: GrantEvidence) => evidence.columnPrivileges.push({
      tableSchema: "spx_prod",
      tableName: "team_runtime_leases",
      columnName: "owner_role",
      privilegeType: "SELECT",
      isGrantable: "NO",
    }),
    (evidence: GrantEvidence) => evidence.columnPrivileges.push({
      tableSchema: "spx_prod",
      tableName: "auto_accept_jobs",
      columnName: "payload_json",
      privilegeType: "SELECT",
      isGrantable: "NO",
    }),
    (evidence: GrantEvidence) => evidence.columnPrivileges.push({
      tableSchema: "spx_prod",
      tableName: "notification_events",
      columnName: "message",
      privilegeType: "SELECT",
      isGrantable: "NO",
    }),
    (evidence: GrantEvidence) => evidence.columnPrivileges.push({
      tableSchema: "spx_prod",
      tableName: "team_runtime_leases",
      columnName: "heartbeat_at",
      privilegeType: "SELECT",
      isGrantable: "NO",
    }),
    (evidence: GrantEvidence) => evidence.tablePrivileges.push({
      tableSchema: "spx_prod",
      tableName: "team_runtime_leases",
      privilegeType: "UPDATE",
      isGrantable: "NO",
    }),
  ]) {
    const excessiveObserverEvidence = structuredClone(phase3ObserverAllowed);
    mutate(excessiveObserverEvidence);
    assert.equal(
      grantModule.evaluateGrantEvidence(
        contract,
        "phase3-observer",
        "spx_service",
        "10.%",
        excessiveObserverEvidence,
      ).failureCodes.includes("excess_privilege_present"),
      true,
    );
  }

  const gate6Control = contract.roles["gate6-control"]!;
  assert.deepEqual(
    grantModule.evaluateGrantEvidence(
      contract,
      "gate6-control",
      "spx_service",
      "10.%",
      evidenceFor(gate6Control),
    ),
    { ok: true, failureCodes: [] },
  );
  const gate6Delete = evidenceFor(gate6Control);
  gate6Delete.tablePrivileges.push({
    tableSchema: "spx_prod",
    tableName: "gate6_actions",
    privilegeType: "DELETE",
    isGrantable: "NO",
  });
  assert.equal(
    grantModule.evaluateGrantEvidence(
      contract,
      "gate6-control",
      "spx_service",
      "10.%",
      gate6Delete,
    ).failureCodes.includes("excess_privilege_present"),
    true,
  );
  const gate6Monitor = contract.roles["gate6-monitor"]!;
  const gate6MonitorAllowed = evidenceFor(gate6Monitor);
  gate6MonitorAllowed.showGrants = [
    "GRANT USAGE ON *.* TO `spx_service`@`10.%` REQUIRE SSL WITH MAX_USER_CONNECTIONS 1",
  ];
  assert.deepEqual(
    grantModule.evaluateGrantEvidence(
      contract,
      "gate6-monitor",
      "spx_service",
      "10.%",
      gate6MonitorAllowed,
    ),
    { ok: true, failureCodes: [] },
  );
  const gate6MonitorWithoutLimit = evidenceFor(gate6Monitor);
  assert.equal(
    grantModule.evaluateGrantEvidence(
      contract,
      "gate6-monitor",
      "spx_service",
      "10.%",
      gate6MonitorWithoutLimit,
    ).failureCodes.includes("account_resource_limit_mismatch"),
    true,
  );
  const observer = contract.roles.observer!;
  assert.deepEqual(
    grantModule.evaluateGrantEvidence(
      contract,
      "observer",
      "spx_service",
      "10.%",
      evidenceFor(observer),
    ),
    { ok: true, failureCodes: [] },
  );
  const observerBusinessRead = evidenceFor(observer);
  observerBusinessRead.tablePrivileges.push({
    tableSchema: "spx_prod",
    tableName: "auto_accept_jobs",
    privilegeType: "SELECT",
    isGrantable: "NO",
  });
  assert.equal(
    grantModule.evaluateGrantEvidence(
      contract,
      "observer",
      "spx_service",
      "10.%",
      observerBusinessRead,
    ).failureCodes.includes("excess_privilege_present"),
    true,
  );
  const immutableControlUpdate = structuredClone(phase3ControlAllowed);
  immutableControlUpdate.columnPrivileges.push({
    tableSchema: "spx_prod",
    tableName: "auto_accept_jobs",
    columnName: "publication_generation",
    privilegeType: "UPDATE",
    isGrantable: "NO",
  });
  assert.equal(
    grantModule.evaluateGrantEvidence(
      contract,
      "phase3-control",
      "spx_service",
      "10.%",
      immutableControlUpdate,
    ).failureCodes.includes("excess_privilege_present"),
    true,
  );

  const mysqlRow = (value: Record<string, unknown>) =>
    Object.assign(Object.create({ mysqlRowPacket: true }) as Record<string, unknown>, value);
  const queryResponses = [
    [mysqlRow({ account: allowed.account, currentRole: "NONE", databaseName: allowed.database })],
    allowed.userPrivileges.map(mysqlRow),
    allowed.schemaPrivileges.map(mysqlRow),
    allowed.tablePrivileges.map(mysqlRow),
    allowed.columnPrivileges.map(mysqlRow),
    [mysqlRow({ "Grants for spx_service@10.%": allowed.showGrants[0] })],
  ];
  const grantQueries: string[] = [];
  const collected = await grantModule.collectGrantEvidence({
    async query(sql: string): Promise<[unknown[], unknown]> {
      grantQueries.push(sql);
      const rows = queryResponses.shift();
      assert.notEqual(rows, undefined, "unexpected grant query");
      return [rows!, []];
    },
  });
  assert.equal(queryResponses.length, 0);
  assert.equal(grantQueries.length, 6);
  assert.equal(grantQueries.some((query) => /ROUTINE_PRIVILEGES/i.test(query)), false);
  assert.equal(collected.account, allowed.account);
  assert.equal(collected.tablePrivileges.length, allowed.tablePrivileges.length);
  assert.deepEqual(collected.showGrants, allowed.showGrants);

  const missingReplayDelete = structuredClone(allowed);
  missingReplayDelete.tablePrivileges = missingReplayDelete.tablePrivileges.filter((row) =>
    !(row.tableName === "internal_request_replays" && row.privilegeType === "DELETE"));
  const missingResult = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "spx_service",
    "10.%",
    missingReplayDelete,
  );
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.failureCodes.includes("required_privilege_missing"), true);
  assert.equal(
    missingResult.failureCodes.includes("internal_request_replays_privilege_mismatch"),
    true,
  );

  const excessiveReplayUpdate = structuredClone(allowed);
  excessiveReplayUpdate.tablePrivileges.push({
    tableSchema: "spx_prod",
    tableName: "internal_request_replays",
    privilegeType: "UPDATE",
    isGrantable: "NO",
  });
  const replayExcessResult = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "spx_service",
    "10.%",
    excessiveReplayUpdate,
  );
  assert.equal(replayExcessResult.failureCodes.includes("excess_privilege_present"), true);
  assert.equal(
    replayExcessResult.failureCodes.includes("internal_request_replays_privilege_mismatch"),
    true,
  );

  const runtimeDdl = structuredClone(allowed);
  runtimeDdl.schemaPrivileges.push({
    tableSchema: "spx_prod",
    privilegeType: "CREATE",
    isGrantable: "NO",
  });
  const runtimeDdlResult = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "spx_service",
    "10.%",
    runtimeDdl,
  );
  assert.equal(runtimeDdlResult.failureCodes.includes("runtime_ddl_privilege_present"), true);
  assert.equal(runtimeDdlResult.failureCodes.includes("excess_privilege_present"), true);

  for (const [mutate, expected] of [
    [
      (evidence: GrantEvidence) => evidence.userPrivileges.push({ privilegeType: "SELECT", isGrantable: "NO" }),
      "global_privilege_present",
    ],
    [
      (evidence: GrantEvidence) => evidence.tablePrivileges.push({
        tableSchema: "spx_staging",
        tableName: "teams",
        privilegeType: "SELECT",
        isGrantable: "NO",
      }),
      "cross_schema_privilege_present",
    ],
    [
      (evidence: GrantEvidence) => { evidence.tablePrivileges[0]!.isGrantable = "YES"; },
      "grant_option_present",
    ],
    [
      (evidence: GrantEvidence) => { evidence.currentRole = "`spx_runtime`@`%`"; },
      "mysql_role_enabled",
    ],
    [
      (evidence: GrantEvidence) => evidence.showGrants.push(
        "GRANT ALL PRIVILEGES ON `spx_prod`.* TO `spx_service`@`10.%`",
      ),
      "all_privileges_present",
    ],
    [
      (evidence: GrantEvidence) => evidence.showGrants.push(
        "GRANT EXECUTE ON PROCEDURE `spx_prod`.`unsafe_proc` TO `spx_service`@`10.%`",
      ),
      "routine_privilege_present",
    ],
  ] as const) {
    const evidence = structuredClone(allowed);
    mutate(evidence);
    const checked = grantModule.evaluateGrantEvidence(
      contract,
      "line-service",
      "spx_service",
      "10.%",
      evidence,
    );
    assert.equal(checked.ok, false);
    assert.equal(checked.failureCodes.includes(expected), true, expected);
  }

  const wrongPrincipal = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "expected_service",
    "10.%",
    allowed,
  );
  assert.equal(wrongPrincipal.failureCodes.includes("principal_mismatch"), true);

  const wrongAccountHost = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "spx_service",
    "10.0.%",
    allowed,
  );
  assert.equal(wrongAccountHost.failureCodes.includes("account_host_mismatch"), true);

  const broadAccount = structuredClone(allowed);
  broadAccount.account = "spx_service@%";
  const broadAccountResult = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "spx_service",
    "10.%",
    broadAccount,
  );
  assert.equal(broadAccountResult.failureCodes.includes("broad_account_host_present"), true);

  const invalidExpectedHost = grantModule.evaluateGrantEvidence(
    contract,
    "line-service",
    "spx_service",
    "%",
    broadAccount,
  );
  assert.equal(
    invalidExpectedHost.failureCodes.includes("account_host_contract_invalid"),
    true,
  );

  const safeEnv = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    NODE_ENV: "production",
    DB_MODE: "mysql",
    DB_HOST: `${sensitive}.example.invalid`,
    DB_PORT: "3306",
    DB_USERNAME: sensitive,
    DB_PASSWORD_FILE: resolve(root, `${sensitive}-missing-password`),
    DB_NAME: sensitive,
    DB_SSL_MODE: "verify-identity",
    DB_SSL_CA_FILE: resolve(root, `${sensitive}-missing-ca`),
  };
  const migratorDryRun = spawnSync(
    process.execPath,
    [scriptPath, "--role=migrator", "--dry-run"],
    { cwd: root, encoding: "utf8", env: safeEnv },
  );
  assert.equal(migratorDryRun.status, 0, migratorDryRun.stderr || migratorDryRun.stdout);
  assert.deepEqual(JSON.parse(migratorDryRun.stdout), {
    ok: true,
    mode: "dry-run",
    role: "migrator",
    failureCodes: [],
  });
  assert.equal(`${migratorDryRun.stdout}\n${migratorDryRun.stderr}`.includes(sensitive), false);

  const webApiDryRun = spawnSync(
    process.execPath,
    [scriptPath, "--role=web-api", "--dry-run"],
    { cwd: root, encoding: "utf8", env: safeEnv },
  );
  assert.equal(webApiDryRun.status, 0, webApiDryRun.stderr || webApiDryRun.stdout);
  assert.deepEqual(JSON.parse(webApiDryRun.stdout), {
    ok: true,
    mode: "dry-run",
    role: "web-api",
    failureCodes: [],
  });
  assert.equal(`${webApiDryRun.stdout}\n${webApiDryRun.stderr}`.includes(sensitive), false);

  const invalidRole = spawnSync(
    process.execPath,
    [scriptPath, `--role=${sensitive}`, "--dry-run"],
    { cwd: root, encoding: "utf8", env: safeEnv },
  );
  assert.equal(invalidRole.status, 1);
  assert.deepEqual(JSON.parse(invalidRole.stdout), {
    ok: false,
    mode: "dry-run",
    role: "invalid",
    failureCodes: ["role_invalid"],
  });
  assert.equal(`${invalidRole.stdout}\n${invalidRole.stderr}`.includes(sensitive), false);

  const invalidLiveConfig = spawnSync(
    process.execPath,
    [scriptPath, "--role=migrator", "--expected-account-host=10.%"],
    { cwd: root, encoding: "utf8", env: safeEnv },
  );
  assert.equal(invalidLiveConfig.status, 1);
  assert.deepEqual(JSON.parse(invalidLiveConfig.stdout), {
    ok: false,
    mode: "live",
    role: "migrator",
    failureCodes: ["database_config_invalid"],
  });
  assert.equal(`${invalidLiveConfig.stdout}\n${invalidLiveConfig.stderr}`.includes(sensitive), false);

  const missingAccountHost = spawnSync(
    process.execPath,
    [scriptPath, "--role=migrator"],
    { cwd: root, encoding: "utf8", env: safeEnv },
  );
  assert.equal(missingAccountHost.status, 1);
  assert.deepEqual(JSON.parse(missingAccountHost.stdout), {
    ok: false,
    mode: "live",
    role: "migrator",
    failureCodes: ["account_host_contract_invalid"],
  });

  const accountHostRoot = mkdtempSync(join(tmpdir(), "spx-db-account-host-"));
  try {
    const accountHostPath = join(accountHostRoot, "expected-host");
    writeFileSync(accountHostPath, "10.%\n", { encoding: "utf8", mode: 0o600 });
    const fileBackedHost = spawnSync(
      process.execPath,
      [scriptPath, "--role=migrator"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...safeEnv, DB_EXPECTED_ACCOUNT_HOST_FILE: accountHostPath },
      },
    );
    assert.equal(fileBackedHost.status, 1);
    assert.deepEqual(JSON.parse(fileBackedHost.stdout), {
      ok: false,
      mode: "live",
      role: "migrator",
      failureCodes: ["database_config_invalid"],
    });
  } finally {
    rmSync(accountHostRoot, { recursive: true, force: true });
  }

  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["db:grants-check"], "node scripts/db-grants-check.mjs");

  const dockerfile = readFileSync(resolve(root, "Dockerfile.a3"), "utf8");
  assert.match(dockerfile, /deploy\/db-grants\.json/);
  assert.match(dockerfile, /scripts\/db-grants-check\.mjs/);

  const compose = readFileSync(resolve(root, "docker-compose.a3.yml"), "utf8");
  for (const role of Object.values(contract.roles).filter((item) => item.principalType === "compose")) {
    assert.equal(typeof role.composeService, "string");
    assert.equal(compose.includes(`  ${role.composeService}:`), true, role.composeService);
    assert.equal(compose.includes(`\${${role.composePrincipalEnv}:?`), true, role.composePrincipalEnv);
  }

  const { OPERATOR_BUNDLE_STATIC_FILES } = await import("../scripts/build-operator-bundle.mjs") as {
    OPERATOR_BUNDLE_STATIC_FILES: readonly string[];
  };
  assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("deploy/db-grants.json"), true);
  assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/db-grants-check.mjs"), true);

  const docs = readFileSync(resolve(root, "docs/env-reference.md"), "utf8");
  assert.match(docs, /## MySQL grant contract/);
  assert.match(docs, /db:grants-check -- --role=migrator --dry-run/);
  assert.match(docs, /runtime_ddl_dependency_unresolved/);
  assert.match(docs, /SELECT, INSERT, DELETE/);
  assert.match(docs, /--expected-account-host/);
  assert.match(docs, /DB_EXPECTED_ACCOUNT_HOST_FILE/);

  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /mysqlScriptConnectionConfigFromEnv/);
  assert.doesNotMatch(
    script,
    /\.(?:query|execute)\(\s*["`](?:CREATE|ALTER|DROP|INDEX|GRANT|REVOKE|TRUNCATE)\b/i,
  );
  console.log("database grant contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
