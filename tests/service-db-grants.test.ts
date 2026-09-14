import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface RoleContract {
  columns: Record<string, Record<string, string[]>>;
  composePrincipalEnv: string;
  composeService: string | null;
  principalType: string;
  runtimeDdlFree: boolean;
  schemaPrivileges: string[];
  tables: Record<string, string[]>;
}

const contract = JSON.parse(readFileSync("deploy/db-grants.json", "utf8")) as {
  roles: Record<string, RoleContract>;
};

assert.equal(
  Object.keys(contract.roles).some((roleName) => /ocr/i.test(roleName)),
  false,
  "OCR must remain database-free",
);

const observer = contract.roles["phase3-observer"];
assert.ok(observer);
assert.deepEqual(observer, {
  columns: {
    auto_accept_attempts: {
      SELECT: [
        "accept_finished_at",
        "ambiguous_accept",
        "created_at",
        "id",
        "team_id",
        "trace_id",
        "worker_node_id",
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
        "booking_id",
        "claim_expires_at",
        "completed_at",
        "created_at",
        "cutover_epoch",
        "id",
        "publication_generation",
        "request_id",
        "result_status",
        "rule_id",
        "status",
        "team_id",
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
  },
  composePrincipalEnv: "SPX_DB_USERNAME_PHASE3_OBSERVER",
  composeService: null,
  principalType: "observer",
  runtimeDdlFree: true,
  schemaPrivileges: [],
  tables: {
    operational_phase3_control_evidence: ["SELECT"],
    operational_phase3_evidence: ["SELECT"],
    schema_migrations: ["SELECT"],
  },
});

const observerPrivileges = [
  ...observer.schemaPrivileges,
  ...Object.values(observer.tables).flat(),
  ...Object.values(observer.columns).flatMap((grants) => Object.keys(grants)),
];
assert.equal(observerPrivileges.every((privilege) => privilege === "SELECT"), true);
assert.equal(
  observerPrivileges.some((privilege) =>
    ["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "INDEX", "DROP"].includes(privilege)),
  false,
);

console.log("service database grant boundary tests passed");
