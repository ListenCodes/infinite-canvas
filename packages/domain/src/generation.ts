import type { BatchStatus, JobStatus } from "@infinite-canvas/contracts";

const transitions: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  queued: new Set(["dispatching", "cancel_requested", "failed"]),
  dispatching: new Set(["running", "cancel_requested", "outcome_unknown", "failed"]),
  running: new Set(["waiting_provider", "materializing", "succeeded", "failed", "cancel_requested", "outcome_unknown"]),
  waiting_provider: new Set(["materializing", "failed", "cancel_requested", "outcome_unknown"]),
  materializing: new Set(["succeeded", "failed", "cancel_requested"]),
  succeeded: new Set(),
  failed: new Set(),
  cancel_requested: new Set(["canceled", "succeeded", "failed", "outcome_unknown", "materializing"]),
  canceled: new Set(),
  outcome_unknown: new Set(["succeeded", "failed", "canceled", "materializing"]),
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) throw new Error(`Invalid generation job transition: ${from} -> ${to}`);
}

export function aggregateBatchStatus(statuses: readonly JobStatus[]): BatchStatus {
  if (statuses.length === 0 || statuses.some((status) => !["succeeded", "failed", "canceled"].includes(status))) {
    return statuses.some((status) => status !== "queued") ? "running" : "queued";
  }
  const succeeded = statuses.filter((status) => status === "succeeded").length;
  if (succeeded === statuses.length) return "succeeded";
  if (succeeded > 0) return "partial_succeeded";
  if (statuses.every((status) => status === "canceled")) return "canceled";
  return "failed";
}

export function calculateCreditTotal(unitCredits: bigint, count: number): bigint {
  if (unitCredits < 0n) throw new RangeError("unitCredits must not be negative");
  if (!Number.isSafeInteger(count) || count < 1 || count > 15) throw new RangeError("count must be an integer from 1 to 15");
  return unitCredits * BigInt(count);
}
