# ADR 0002: Reliability, billing, and schema resolutions

- Status: accepted
- Baseline: design v1.1

## Decision

### Delivery and attempts

- Every generation command owns one batch. Every requested slot owns one job. Every execution or billable retry owns a new attempt.
- HTTP idempotency is persisted by `(workspace_id, operation, key)` with a request hash and response snapshot. Reusing a key with a different request is rejected.
- `outbox_events.dedupe_key` is unique and stable per attempt. Dispatch uses a lease plus `FOR UPDATE SKIP LOCKED`.
- The first Worker step claims an attempt with compare-and-set. Later state changes also require the job's `current_attempt_id` and version so a late attempt cannot overwrite a newer attempt.
- Hatchet beta idempotency uses the attempt's persisted dispatch-generation token only as an additional defense. Retries of one dispatch generation reuse that token; a recovery workflow gets a new token while database CAS fences the old executor.
- Before crossing the Hatchet client boundary, the dispatcher persists the same token in `outbox_events.dispatch_started_token`. Once present, transport, run-ID lookup, process-crash, and later preflight ambiguity can only requeue that token; they cannot fail the business attempt or release its reservation.

### Paid provider calls

- Provider adapters classify submission as `completed`, `accepted`, `rejected`, or `outcome_unknown`.
- A paid non-idempotent create POST has zero automatic retries unless the provider contract proves both idempotent submission and lookup.
- A lost response after possible acceptance becomes `outcome_unknown`; it never triggers another create call automatically.
- Cancellation before submission releases all reserved credits. Accepted work converges to its real terminal state. Materialized assets are settled and remain available to the user.

### Billing

- Credit reservations belong to attempts, not jobs. This resolves the design tension between one initial reservation per job and a new chargeable reservation for each billable retry.
- Wallet amounts and ledger amounts use signed PostgreSQL `bigint`; public JSON represents them as decimal strings.
- Reserve, settle, release, unknown-timeout release, and risk write-off use separate unique ledger idempotency keys.
- `outcome_unknown` schedules reconciliation at one hour and forced user release at 24 hours. A late provider charge is platform risk and cannot be silently charged back to the user.

### Tenant and event schema

- `generation_jobs` and all user-visible child tables include `workspace_id` even when derivable. This supports RLS, tenant-local indexes, and composite foreign keys.
- `generation_job_targets` is authoritative for project/node/slot mapping. Jobs do not duplicate `target_node_id`.
- Attempts freeze `channel_id`, adapter version, model snapshot, price snapshot, provider idempotency capability, and business deadline. A partial unique index covers non-null `(channel_id, provider_task_id)`.
- The persistent event table supports aggregate type/id plus optional project, batch, job, and attempt references. The global sequence is returned to JavaScript as a decimal string.
- LISTEN/NOTIFY transports only a small wake-up payload. Persistent events and cursor scans are authoritative.

## Consequences

- Database constraints and transactions carry the core correctness proof; application and Hatchet logic cannot weaken them.
- A retry that only downloads, stores, binds, or settles existing output does not reserve or charge again.
- Admin reconciliation requires evidence and an audit reason for every manual outcome change.
