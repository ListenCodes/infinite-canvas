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
3. Wait until the new Worker is healthy and registered in Hatchet. The old image
   registers `media-generation-v1`; the candidate image registers the distinct
   `media-generation-v2` contract and its version 2 image/video tasks.
4. Deploy the version 2 API with `GENERATION_WRITES_ENABLED=false` and verify that
   new batch, paid retry, and nonterminal administrator recovery requests return
   `503 generation_writes_paused`. Reads, cancellation, and terminal unknown
   resolution remain available. Do not queue version 2 attempts during this
   interval: their 30-minute business deadline starts when the API commits them.
   Keep both dispatcher and reconciler ownership on the old revision.
5. Wait until every version 1 generation Outbox row is `sent`, no old execution
   can create another recovery row, and every version 1 attempt has left
   `created`, `claimed`, `submitting`, `accepted`, `materializing`, and
   `outcome_unknown`. A `sent` Outbox row with a `created` attempt is still an
   accepted Hatchet run waiting to claim and therefore blocks the handoff.
   Version 1 predates the shared lease and RPM ledgers, so starting version 2
   provider work before this point can exceed workspace or channel capacity even
   though Outbox claims are version-separated. Abort on any dead or stuck v1 row;
   never cancel and recreate accepted provider work to shorten the drain.
6. Prepare a handoff env with all four owner flags `false` and
   `GENERATION_WRITES_ENABLED=false`. Validate it with
   `node scripts/validate-deployment-config.mjs --allow-zero-drain-owners --env-file <handoff-env>`.
   Disable both old owner flags and recreate only `worker`; confirm zero dispatcher
   and zero reconciler owners. Then use the normal validator on an env with both
   candidate flags `true`, recreate only `worker-new`, and confirm exactly one owner
   of each subsystem. A double-owner observation is a release blocker.
7. Set `GENERATION_WRITES_ENABLED=true`, recreate the version 2 API, verify its
   readiness, and submit one canary request. Its business deadline must be computed
   after writes are re-enabled, and only the candidate may claim its version 2 row.
8. Stop the old Worker gracefully after its Hatchet runs and business attempts are
   terminal. The 50-minute Compose grace period is a ceiling,
   not evidence that drain completed.
9. Remove v1 code only in a later release after backup retention and reconciliation
   windows have elapsed.

For Cloud, compose with `infra/compose/cloud/compose.yaml` and
`infra/compose/cloud/drain.override.yaml`; for OSS use the equivalent files under
`infra/compose/oss`. Use targeted `docker compose up -d --no-deps worker` and
`worker-new` commands during handoff so both flag changes are never applied in an
unspecified order. Do not use `--scale` on an owner-enabled service. The override
labels both revisions for monitoring and evidence collection.

Use the same Compose project name and the runtime env file for every command. Copy
the three checked-in state examples to an operations directory outside Git, replace
both image placeholders with the release digests, and keep the resulting files as
release evidence. The following Cloud command contract is literal; for OSS replace
`cloud` with `oss` and add `--profile application` to each command:

```bash
compose_dir=infra/compose/cloud
runtime_env=/run/infinite-canvas/cloud.env
prepared_env=/run/infinite-canvas/drain.prepared.env
handoff_env=/run/infinite-canvas/drain.handoff.env
candidate_env=/run/infinite-canvas/drain.candidate.env

compose() {
  local drain_env="$1"
  shift
  docker compose --project-name infinite-canvas-cloud \
    --env-file "$runtime_env" --env-file "$drain_env" \
    -f "$compose_dir/compose.yaml" -f "$compose_dir/drain.override.yaml" \
    "$@"
}

node scripts/validate-deployment-config.mjs --env-file "$prepared_env"
compose "$prepared_env" config --quiet
compose "$prepared_env" up -d --no-deps worker worker-new api

node scripts/validate-deployment-config.mjs --allow-zero-drain-owners \
  --env-file "$handoff_env"
compose "$handoff_env" config --quiet
compose "$handoff_env" up -d --no-deps api
compose "$handoff_env" up -d --no-deps worker-new
compose "$handoff_env" up -d --no-deps worker

node scripts/validate-deployment-config.mjs --env-file "$candidate_env"
compose "$candidate_env" config --quiet
compose "$candidate_env" up -d --no-deps worker-new
compose "$candidate_env" up -d --no-deps api
```

`drain.env.example`, `drain.handoff.env.example`,
`drain.candidate.env.example`, and `drain.rollback.env.example` are the prepared,
zero-owner, candidate-owner, and previous-owner completion templates respectively.
Never concatenate them with the runtime env: later duplicate
keys are hard to audit. Compose must receive both files with ordered `--env-file`
arguments so the drain state overrides `GENERATION_WRITES_ENABLED` explicitly.

## Drain proof queries

Record the maintenance start time before step 4. Run these read-only queries with
the recovery-audit connection. Bind `:maintenance_started` to that recorded UTC
timestamp using the SQL client (or replace it with an explicit `timestamptz`
literal). The first two queries must return no rows before handoff; the third count
must remain zero while writes are paused.

```sql
begin;
select set_config('app.service_role', 'on', true);

select status, count(*)
from outbox_events
where topic = 'generation.job.requested'
  and payload->>'schemaVersion' = '1'
  and status in ('pending', 'sending', 'dead')
group by status;

select attempt.status, count(distinct attempt.id)
from generation_attempts attempt
where attempt.status in (
  'created', 'claimed', 'submitting', 'accepted', 'materializing',
  'outcome_unknown'
)
and exists (
  select 1 from outbox_events event
  where event.topic = 'generation.job.requested'
    and event.payload->>'schemaVersion' = '1'
    and event.payload->>'attemptId' = attempt.id::text
)
group by attempt.status;

select count(*)
from outbox_events
where topic = 'generation.job.requested'
  and payload->>'schemaVersion' = '2'
  and created_at >= :maintenance_started;

rollback;
```

Only the legacy dispatcher executes during the v1 drain; version 2 writes remain
paused until after the owner handoff. Version-separated claims prevent either revision
from consuming the wrong contract, and malformed generation payloads are routed
to the candidate after cutover so they fail closed instead of remaining invisible.
Hatchet keeps already-created version 1 runs on the old registered workflow while
new runs target `media-generation-v2` after cutover. Unknown-outcome reconciliation
remains business-database based and must stay enabled on exactly one active
revision. Compose cannot enforce singleton ownership across multiple
Compose projects or manual replicas; operators must prove the owner counts at
each transition and abort on any double-owner observation.

## Abort conditions

Stop routing new work to the candidate when error rate, Outbox age, unknown count,
provider create count, ledger mismatch, or SSE recovery exceeds the release SLO.
Do not kill accepted/materializing runs. For rollback, first set
`GENERATION_WRITES_ENABLED=false`, recreate the API, and verify that batch creation,
paid retry, and nonterminal administrator recovery each return
`503 generation_writes_paused`. Automatic unknown reconciliation remains owned by
the current Worker until the owner handoff; terminal administrator resolutions stay
available, while `accepted` and `provider_succeeded` recovery remain paused. Then
disable both owner flags on `worker-new`, validate and confirm the explicit zero-owner
state, enable both on `worker`, and restore the previous dispatcher routing. Keep the
candidate available for runs it already claimed and follow the rollback runbook.

Cloud and OSS drain must each be exercised in Staging. SDK graceful shutdown tests
and a large `stop_grace_period` do not prove cross-version drain. The evidence must
include one version 1 run finishing on the old image before one version 2 run starts
on the candidate, the measured zero-owner handoff, unchanged provider task IDs,
and no duplicate reservation, capacity lease, rate-window, or ledger entry.
