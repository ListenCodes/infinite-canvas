# ADR 0003: Generation capacity control

- Status: accepted
- Baseline: design v1.1

## Context

Generation has three independent capacity scopes:

- a workspace must not monopolize image or video execution;
- every provider channel has a capability-specific concurrency contract;
- provider requests need workspace and channel rate protection.

Hatchet concurrency expressions are evaluated before a task handler can acquire a
business-database lease. A channel-busy activation would therefore consume a
Hatchet rate token without making a provider request. Unknown-outcome provider
queries also originate from the business reconciler and must share the same channel
limits as normal workflow execution.

## Decision

- Hatchet remains authoritative for workflow execution, durable scheduling, and
  workspace fairness. Image workflows use a fixed workspace concurrency of three;
  video workflows use two. The strategy is group round-robin.
- PostgreSQL is authoritative for dynamic channel concurrency and both workspace
  and channel per-minute request limits. Lease admission locks the workspace,
  channel, and current attempt, verifies the frozen identity, and creates or
  renews the channel lease. A separate request-time transaction verifies that
  lease and atomically consumes both minute counters immediately before an
  actual provider create, poll, or cancel call.
- A child activation performs at most one provider control-plane request. Pending
  work returns to Hatchet durable scheduling instead of sleeping in a Worker slot.
- Capacity policies are append-only and versioned by channel and capability. Every
  attempt freezes the policy version, workspace limits, and channel limits. Retry
  attempts take a new current snapshot without changing historical attempts.
- Terminal attempts release leases by database trigger. Explicit release is an
  idempotent optimization fenced by the attempt dispatch-generation token, so a
  stale executor cannot delete a newer generation's lease.
- `outcome_unknown` is excluded from normal dispatch. Its lease remains reserved
  because the provider may still be running the accepted task. Authoritative
  provider-task reconciliation uses a fenced, expiring claim, shares the same
  workspace/channel lease and request-rate gates, and never issues a new paid
  create request. The lease is released only after an authoritative terminal
  result, successful handoff to materialization, or the 24-hour uncertainty
  release.
- Provider cancellation records a fenced `attempting` evidence marker before the
  external call. A transport-ambiguous cancel is persisted as `unknown`; later
  activations poll instead of replaying the cancel request.
- Policy values are administration inputs and load-test starting points, not
  provider SLA claims. Changing a model with unchanged channel limits reuses the
  current policy version; changing either limit appends the next version.

## Consequences

- Hatchet dashboards show workspace execution pressure; database capacity tables
  show provider-channel and rate pressure. Operations must monitor both.
- Dynamic provider limits can change without redefining a Hatchet workflow, while
  every in-flight attempt retains deterministic limits.
- The database serializes capacity admission. Real PostgreSQL contention and load
  tests remain mandatory before Production sizing.
- Workflow contract 2 uses `schemaVersion: 2` and the distinct
  `media-generation-v2` workflow. The old Worker keeps
  `media-generation-v1` registered until all version 1 runs drain; existing
  provider work is never canceled and recreated during upgrade. The legacy
  two-argument Outbox claim function is restricted to version 1 generation
  rows; current Workers claim version 2 through an explicit three-argument
  overload. Version 1 Workers do not write the version 2 lease and rate ledgers,
  so the two dispatchers must never execute provider work concurrently. The
  version 2 API runs with generation writes paused while version 1 drains;
  ownership moves through a measured zero-dispatcher handoff only after every
  version 1 provider-capable attempt, including `outcome_unknown`, has converged.
