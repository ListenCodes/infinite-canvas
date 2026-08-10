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
