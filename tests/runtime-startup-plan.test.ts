import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  httpSurfaceForRole,
  roleRunsAutoAcceptWorkers,
  roleRunsPollers,
  type HttpSurface,
  type RuntimeRole,
} from "../src/services/runtime-role.js";

interface RuntimeStartupPlan {
  httpSurface: HttpSurface | null;
  runHttp: boolean;
  runTeamRuntimeManager: boolean;
  runTeamRuntimeLease: boolean;
  runDesiredStateLoop: boolean;
  runTeamRuntimeActions: boolean;
  runDistributedTeamRuntimeActions: boolean;
  pollerAssignedTeamIds: number[] | undefined;
  autoAcceptTeamIds: number[];
  runAutoAcceptDryRunLoop: boolean;
  runAutoAcceptRealLoop: boolean;
  runAutoAcceptSettlementLoop: boolean;
}

type BuildRuntimeStartupPlan = (input: {
  role: RuntimeRole;
  runTeamIds: number[];
  dryRunWorkerEnabled: boolean;
  realWorkerEnabled: boolean;
  settlementWorkerEnabled: boolean;
}) => RuntimeStartupPlan;

async function main(): Promise<void> {
  const startupPlanModuleUrl = pathToFileURL(
    resolve(process.cwd(), "src/services/runtime-startup-plan.ts"),
  ).href;
  const startupPlanModule = await import(startupPlanModuleUrl).catch(() => null) as {
    buildRuntimeStartupPlan?: BuildRuntimeStartupPlan;
  } | null;
  assert.ok(startupPlanModule, "runtime startup plan module must exist");
  assert.equal(typeof startupPlanModule.buildRuntimeStartupPlan, "function");
  const buildRuntimeStartupPlan = startupPlanModule.buildRuntimeStartupPlan;

  const roles: RuntimeRole[] = [
    "api",
    "worker",
    "notifier",
    "combined",
    "notification-service",
    "line-service",
    "ocr-service",
    "poller-service",
    "auto-accept-service",
    "realtime-service",
    "migrator",
  ];
  const runTeamIds = [7, 11];

  for (const role of roles) {
    for (let flags = 0; flags < 8; flags += 1) {
      const dryRunWorkerEnabled = Boolean(flags & 1);
      const realWorkerEnabled = Boolean(flags & 2);
      const settlementWorkerEnabled = Boolean(flags & 4);
      const plan = buildRuntimeStartupPlan({
        role,
        runTeamIds,
        dryRunWorkerEnabled,
        realWorkerEnabled,
        settlementWorkerEnabled,
      });
      const runsPollers = roleRunsPollers(role);
      const runsAutoAcceptWorkers = roleRunsAutoAcceptWorkers(role);
      const expectedHttpSurface = httpSurfaceForRole(role);
      const caseName = `${role}:${flags.toString(2).padStart(3, "0")}`;

      assert.equal(plan.httpSurface, expectedHttpSurface, `${caseName}: HTTP surface`);
      assert.equal(plan.runHttp, expectedHttpSurface !== null, `${caseName}: HTTP ownership`);
      assert.equal(plan.runTeamRuntimeManager, runsPollers, `${caseName}: runtime manager`);
      assert.equal(plan.runTeamRuntimeLease, runsPollers, `${caseName}: runtime lease`);
      assert.equal(plan.runDesiredStateLoop, runsPollers, `${caseName}: desired-state loop`);
      assert.equal(plan.runTeamRuntimeActions, runsPollers, `${caseName}: team actions`);
      assert.equal(
        plan.runDistributedTeamRuntimeActions,
        expectedHttpSurface === "web-api" && !runsPollers,
        `${caseName}: distributed team actions`,
      );
      assert.equal(
        plan.runAutoAcceptDryRunLoop,
        runsAutoAcceptWorkers && dryRunWorkerEnabled,
        `${caseName}: dry-run loop`,
      );
      assert.equal(
        plan.runAutoAcceptRealLoop,
        runsAutoAcceptWorkers && realWorkerEnabled,
        `${caseName}: real loop`,
      );
      assert.equal(
        plan.runAutoAcceptSettlementLoop,
        runsAutoAcceptWorkers && settlementWorkerEnabled,
        `${caseName}: settlement loop`,
      );
      assert.deepEqual(plan.autoAcceptTeamIds, runTeamIds, `${caseName}: auto-accept assignment`);

      const expectedPollerAssignment = role === "poller-service" || role === "worker"
        ? runTeamIds
        : undefined;
      assert.deepEqual(
        plan.pollerAssignedTeamIds,
        expectedPollerAssignment,
        `${caseName}: poller assignment`,
      );
    }
  }

  const isolatedInput = [3, 5];
  const isolatedPlan = buildRuntimeStartupPlan({
    role: "poller-service",
    runTeamIds: isolatedInput,
    dryRunWorkerEnabled: false,
    realWorkerEnabled: false,
    settlementWorkerEnabled: false,
  });
  isolatedInput.push(9);
  assert.deepEqual(isolatedPlan.pollerAssignedTeamIds, [3, 5]);
  assert.deepEqual(isolatedPlan.autoAcceptTeamIds, [3, 5]);

  const realtimePlan = buildRuntimeStartupPlan({
    role: "realtime-service",
    runTeamIds: [3, 5],
    dryRunWorkerEnabled: true,
    realWorkerEnabled: true,
    settlementWorkerEnabled: true,
  });
  assert.equal(realtimePlan.httpSurface, "realtime-service");
  assert.equal(realtimePlan.runHttp, true);
  assert.equal(realtimePlan.runTeamRuntimeManager, false);
  assert.equal(realtimePlan.runTeamRuntimeLease, false);
  assert.equal(realtimePlan.runDesiredStateLoop, false);
  assert.equal(realtimePlan.runTeamRuntimeActions, false);
  assert.equal(realtimePlan.runDistributedTeamRuntimeActions, false);
  assert.equal(realtimePlan.runAutoAcceptDryRunLoop, false);
  assert.equal(realtimePlan.runAutoAcceptRealLoop, false);
  assert.equal(realtimePlan.runAutoAcceptSettlementLoop, false);

  const appSource = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
  assert.match(appSource, /buildRuntimeStartupPlan/);
  assert.doesNotMatch(appSource, /roleRunsWorkers/);
  assert.match(appSource, /startupPlan\.runTeamRuntimeManager/);
  assert.match(appSource, /assignedTeamIds:\s*startupPlan\.pollerAssignedTeamIds/);
  assert.match(appSource, /lease:\s*startupPlan\.runTeamRuntimeLease/);
  assert.match(appSource, /desiredState:\s*startupPlan\.runDesiredStateLoop/);
  assert.match(appSource, /startupPlan\.runTeamRuntimeActions/);
  assert.match(appSource, /startupPlan\.runDistributedTeamRuntimeActions/);
  assert.match(appSource, /createDistributedTeamRuntimeActions/);
  assert.match(appSource, /startupPlan\.runAutoAcceptDryRunLoop/);
  assert.match(appSource, /startupPlan\.runAutoAcceptRealLoop/);
  assert.match(appSource, /startupPlan\.runAutoAcceptSettlementLoop/);
  assert.match(appSource, /manager\?\.stopAll\(\)/);
  assert.match(appSource, /roleUsesDatabase\(env\.SPX_ROLE\)/);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
