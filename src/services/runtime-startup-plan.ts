import {
  httpSurfaceForRole,
  roleRunsAutoAcceptWorkers,
  roleRunsPollers,
  type HttpSurface,
  type RuntimeRole,
} from "./runtime-role.js";

export interface RuntimeStartupPlanInput {
  role: RuntimeRole;
  runTeamIds: number[];
  dryRunWorkerEnabled: boolean;
  realWorkerEnabled: boolean;
  settlementWorkerEnabled: boolean;
}

export interface RuntimeStartupPlan {
  httpSurface: HttpSurface | null;
  runHttp: boolean;
  runTeamRuntimeManager: boolean;
  runTeamRuntimeLease: boolean;
  runDesiredStateLoop: boolean;
  runTeamRuntimeActions: boolean;
  runDistributedTeamRuntimeActions: boolean;
  pollerAssignedTeamIds: number[] | undefined;
  autoAcceptTeamIds: number[];
  executionMetricsPublication: "dedicated" | "primary-owned" | "disabled";
  runAutoAcceptDryRunLoop: boolean;
  runAutoAcceptRealLoop: boolean;
  runAutoAcceptSettlementLoop: boolean;
}

export function buildRuntimeStartupPlan(input: RuntimeStartupPlanInput): RuntimeStartupPlan {
  const runPollers = roleRunsPollers(input.role);
  const runAutoAcceptWorkers = roleRunsAutoAcceptWorkers(input.role);
  const httpSurface = httpSurfaceForRole(input.role);
  const runTeamIds = [...input.runTeamIds];

  return {
    httpSurface,
    runHttp: httpSurface !== null,
    runTeamRuntimeManager: runPollers,
    runTeamRuntimeLease: runPollers,
    runDesiredStateLoop: runPollers,
    runTeamRuntimeActions: runPollers,
    runDistributedTeamRuntimeActions: httpSurface === "web-api" && !runPollers,
    pollerAssignedTeamIds: input.role === "poller-service" || input.role === "worker"
      ? [...runTeamIds]
      : undefined,
    autoAcceptTeamIds: runTeamIds,
    executionMetricsPublication: runAutoAcceptWorkers ? (runPollers ? "primary-owned" : "dedicated") : "disabled",
    runAutoAcceptDryRunLoop: runAutoAcceptWorkers && input.dryRunWorkerEnabled,
    runAutoAcceptRealLoop: runAutoAcceptWorkers && input.realWorkerEnabled,
    runAutoAcceptSettlementLoop: runAutoAcceptWorkers && input.settlementWorkerEnabled,
  };
}
