# Worker Upgrade and Drain Runbook

Workflow versions are immutable execution contracts. Existing runs continue on
the Worker version that understands them; upgrades do not cancel and recreate
provider work.

## v1 to v2 sequence

1. Apply expand-only database migrations that both revisions understand.
2. Render the base Compose file together with `drain.override.yaml` and its
   topology-specific drain env file. Keep the existing `worker` service as the
   old revision and start `worker-new` with both owner flags set to `false`.
   Both images must be immutable digest references.
3. Wait until the new Worker is healthy and registered in Hatchet.
4. Set the old revision's dispatcher and reconciler flags to `false`, then
   recreate only `worker`. Confirm that both owner counts are zero. A short zero
   owner interval is safe because Outbox rows remain durable; a double-owner
   interval is forbidden.
5. Set the new revision's dispatcher and reconciler flags to `true`, recreate
   only `worker-new`, and confirm that each owner count is exactly one. Change
   the dispatcher routing constant for newly created attempts to v2 only after
   the new owner is healthy.
6. Keep the old execution Worker running. Observe Hatchet runs and business
   attempts for v1 until no v1 attempts
   are `claimed`, `submitting`, `accepted`, or `materializing` and no v1 recovery
   Outbox event is pending/sending.
7. Stop the old Worker gracefully. The 50-minute Compose grace period is a ceiling,
   not evidence that drain completed.
8. Remove v1 code only in a later release after backup retention and reconciliation
   windows have elapsed.

For Cloud, compose with `infra/compose/cloud/compose.yaml` and
`infra/compose/cloud/drain.override.yaml`; for OSS use the equivalent files under
`infra/compose/oss`. Use targeted `docker compose up -d --no-deps worker` and
`worker-new` commands during handoff so both flag changes are never applied in an
unspecified order. Do not use `--scale` on an owner-enabled service. The override
labels both revisions for monitoring and evidence collection.

Only one revision may dispatch new work for a workflow version. Unknown-outcome
reconciliation remains business-database based and must stay enabled on exactly
one active revision. Compose cannot enforce singleton ownership across multiple
Compose projects or manual replicas; operators must prove the owner counts at
each transition and abort on any double-owner observation.

## Abort conditions

Stop routing new work to the candidate when error rate, Outbox age, unknown count,
provider create count, ledger mismatch, or SSE recovery exceeds the release SLO.
Do not kill accepted/materializing runs. For rollback, first disable both owner
flags on `worker-new` and confirm zero owners, then enable both on `worker` and
restore the previous dispatcher routing. Keep the candidate available for runs it
already claimed and follow the rollback runbook.

Cloud and OSS drain must each be exercised in Staging. SDK graceful shutdown tests
and a large `stop_grace_period` do not prove cross-version drain.
