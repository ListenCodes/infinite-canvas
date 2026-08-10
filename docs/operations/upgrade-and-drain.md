# Worker Upgrade and Drain Runbook

Workflow versions are immutable execution contracts. Existing runs continue on
the Worker version that understands them; upgrades do not cancel and recreate
provider work.

## v1 to v2 sequence

1. Apply expand-only database migrations that both revisions understand.
2. Deploy the new Worker with both `media-generation-v1` and the new workflow
   registered, but with `OUTBOX_DISPATCHER_ENABLED=false`.
3. Wait until the new Worker is healthy and registered in Hatchet.
4. Change only the dispatcher routing constant for newly created attempts to v2
   and deploy a single dispatcher-enabled new revision.
5. Disable the old revision's dispatcher. Keep its execution Worker running.
6. Observe Hatchet runs and business attempts for v1. Drain until no v1 attempts
   are `claimed`, `submitting`, `accepted`, or `materializing` and no v1 recovery
   Outbox event is pending/sending.
7. Stop the old Worker gracefully. The 50-minute Compose grace period is a ceiling,
   not evidence that drain completed.
8. Remove v1 code only in a later release after backup retention and reconciliation
   windows have elapsed.

Run old and new revisions with different service names and immutable image digests.
Only one revision may dispatch new work for a workflow version. Unknown-outcome
reconciliation remains business-database based and must stay enabled on exactly one
active revision.

## Abort conditions

Stop routing new work to the candidate when error rate, Outbox age, unknown count,
provider create count, ledger mismatch, or SSE recovery exceeds the release SLO.
Do not kill accepted/materializing runs. Restore the previous dispatcher routing,
keep the candidate available for runs it already claimed, and follow the rollback
runbook.

Cloud and OSS drain must each be exercised in Staging. SDK graceful shutdown tests
and a large `stop_grace_period` do not prove cross-version drain.
