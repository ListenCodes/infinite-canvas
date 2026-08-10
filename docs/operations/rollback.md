# Rollback Runbook

Rollback is a coordinated change across Web, API, Worker, workflow routing, schema,
and object state. Never switch an active server-side job back to browser-direct
execution.

## Application rollback

1. Set `GENERATION_WRITES_ENABLED=false`, recreate the API, and verify that batch
   creation, paid retry, and nonterminal administrator recovery return
   `503 generation_writes_paused`. An ingress maintenance rule may be added as a
   second barrier but cannot replace the server-side gate. Keep reads, SSE, terminal
   administrator resolution, automatic reconciliation, and running Workers on.
2. Capture current image digests, migration checksums, Outbox counts, active attempt
   states, wallet totals, event cursor, and object inventory checkpoint.
3. Restore the previous Web and API digests if they are compatible with the expanded
   schema. Keep both Worker revisions until their owned workflow runs drain.
4. Route new attempts to the previous workflow version only after confirming its
   adapter/model schema still accepts the current database snapshots.
5. Re-enable creation gradually and verify one image, one video, cancel, retry,
   unknown reconciliation, SSE reconnect, and wallet invariants.

### Reverse Worker owner handoff

The rollback is not complete until the previous Worker is the sole dispatcher and
reconciler owner. Use the same Compose project, base file, drain override, and runtime
env that were used for the forward handoff. For OSS add `--profile application` to
each Compose command.

```bash
compose_dir=infra/compose/cloud
runtime_env=/run/infinite-canvas/cloud.env
handoff_env=/run/infinite-canvas/drain.handoff.env
rollback_env=/run/infinite-canvas/drain.rollback.env

compose() {
  local drain_env="$1"
  shift
  docker compose --project-name infinite-canvas-cloud \
    --env-file "$runtime_env" --env-file "$drain_env" \
    -f "$compose_dir/compose.yaml" -f "$compose_dir/drain.override.yaml" \
    "$@"
}

# First close the server-side write gate and prove all three write paths return 503.
compose "$handoff_env" up -d --no-deps api

# Disable only the candidate owners, then prove dispatcher=0 and reconciler=0.
node scripts/validate-deployment-config.mjs --allow-zero-drain-owners \
  --env-file "$handoff_env"
compose "$handoff_env" up -d --no-deps worker-new

# Enable only the previous owners while the API remains paused.
node scripts/validate-deployment-config.mjs --env-file "$rollback_env"
compose "$rollback_env" up -d --no-deps worker

# Restore the previous API/workflow route, verify the old owners are unique, and only
# then reopen generation writes.
compose "$rollback_env" up -d --no-deps api
```

Do not recreate `worker` and `worker-new` in one command during this handoff. Record
the observed zero-owner interval, the unique previous owners, and the first accepted
post-rollback request. The API must remain on the handoff env until the old route and
owners have both been verified.

## Data rules

- Ledger entries are append-only. Never reverse them by update/delete; use an
  explicit compensating admin adjustment with idempotency and audit reason.
- Assets already stored and settled remain available to the user.
- Cancellation before provider submission releases the reservation. Accepted work
  remains frozen until authoritative terminal state or the 24-hour unknown policy.
- An expanded schema stays in place during normal rollback. Contract migrations run
  only after all compatible revisions and recovery windows have drained.
- Browser imports are idempotent and do not delete original local data.

## Emergency control-plane switch

Hatchet Cloud to OSS is a new scheduling control plane, not a database rollback.
Pause dispatch, preserve the business Outbox, start the compatible OSS Worker, and
reconcile each current attempt against its old Hatchet run before releasing the
Outbox. Never bulk recreate accepted upstream tasks.

Record who approved rollback, immutable before/after digests, timestamps, affected
jobs, reconciliation queries, and the point at which new writes resumed.
