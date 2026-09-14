import type { AutoAcceptJobExecutionMode } from "../repositories/auto-accept-job-repository.js";
import type { AutoAcceptJobExecutionResult } from "./auto-accept-worker.js";

/** An epoch binds the producer; only explicit cutover intent admits business side effects. */
export function rejectUnadmittedAutoAcceptJob(
  executionMode: AutoAcceptJobExecutionMode | undefined,
): AutoAcceptJobExecutionResult | null {
  if (executionMode === "cutover") return null;
  return {
    outcome: executionMode === "shadow" ? "cancelled" : "indeterminate",
    reasonCode: executionMode === "shadow" ? "shadow_job_not_executable" : "legacy_job_admission_ambiguous",
    preserveEvidence: true,
  };
}
