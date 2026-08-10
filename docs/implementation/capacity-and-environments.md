# Capacity and environment baseline

## Environment isolation

Development, Staging, and Production use separate business databases, Supabase projects, storage buckets, Hatchet tenants or control planes, credentials, and domains. Hatchet's internal PostgreSQL is never the business database.

| Environment | Hatchet | Business data | Runtime |
|---|---|---|---|
| Development | Hatchet Lite, pinned version | PostgreSQL 17.10 plus local S3-compatible test storage | local Web/API/Worker processes or Compose |
| Staging | Hatchet Cloud development tenant and an OSS exercise target | dedicated managed Supabase/PostgreSQL 17 and private bucket | independent Web/API/Worker containers |
| Production | Hatchet Cloud initially; pinned OSS recovery target | dedicated managed Supabase/PostgreSQL 17 with PITR and private bucket | at least separate API and Worker containers |

## Initial Staging request

- API: 1 vCPU, 1 GiB memory, two replicas for SSE fan-out tests.
- Worker: 2 vCPU, 2 GiB memory, one replica initially and two for crash/drain tests.
- API database pool: size 10 per replica plus one dedicated direct/session LISTEN connection.
- Worker database pool: size 10 per replica.
- Image concurrency: three per workspace; video concurrency: two per workspace.
  Hatchet enforces these fixed workspace limits with group round-robin fairness.
- Each channel and capability has an append-only capacity policy with a dynamic
  concurrency limit and requests-per-minute limit. PostgreSQL freezes the current
  policy into every attempt and enforces channel leases plus workspace/channel
  minute windows before a provider request.
- Request body, project JSON, upload, media output, SSE connection, and signed-URL TTL limits are explicit configuration, not unbounded defaults.

These numbers are test starting points, not production capacity claims. Staging load results must record P50/P95/P99, outbox age, Worker slots, provider error rates, SSE reconnects, database connections, and memory before Production sizing.

## Runtime capacity behavior

- One workflow child activation may make at most one provider create, poll, cancel,
  or reconciliation request. Pending provider work is rescheduled durably.
- A channel-busy or rate-limited activation returns without calling the provider.
  Hatchet retries it later under the same persisted attempt and dispatch token.
- Lease admission and provider request-rate consumption are separate. Loading,
  validation, deadline convergence, duplicate detection, and object
  materialization do not consume a provider RPM unit; submit, poll, cancel, and
  authoritative reconciliation consume one immediately before the external call.
- Normal dispatch accepts only `created`, `claimed`, `submitting`, `accepted`, and
  `materializing`. `outcome_unknown` can only enter the authoritative reconciliation
  path and cannot be redispatched into another create request.
- Terminal state transitions release the channel lease in PostgreSQL. Lease expiry
  is crash recovery, not the normal release path.
- An `outcome_unknown` attempt retains its lease through the uncertainty window,
  because a lost response may hide an active provider task. Reconciliation renews
  the same lease, and a successful reconciliation retains it through materialization.
  Only a terminal attempt transition, including the 24-hour release, removes it.
- Capacity policy changes apply to new attempts. Existing attempts continue with
  their immutable snapshot, including recovery workflows.
- Version 1 Workers predate the shared lease and request-rate ledgers. During the
  v1-to-v2 upgrade, the version 2 API rejects new generation writes until every
  version 1 provider-capable attempt has converged and dispatcher ownership has
  moved through a confirmed zero-owner handoff.

The ownership split is recorded in
[`ADR 0003`](../adr/0003-generation-capacity-control.md). Hatchet rate limits are
not used for dynamic provider limits because their admission occurs before the
database can reject a channel-busy activation.

## External gates

No managed resource is created by repository code. Real Staging exit requires user-approved capacity, a Supabase project, a Hatchet Cloud tenant, private object storage, domains, secrets, and a Cloud-to-OSS switch exercise. Until then, only local, container, contract, and fault-injection results may be reported as passed.
