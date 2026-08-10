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
- Image concurrency: three per workspace; video concurrency: two per workspace. Provider limits remain channel-specific and must be set from load tests.
- Request body, project JSON, upload, media output, SSE connection, and signed-URL TTL limits are explicit configuration, not unbounded defaults.

These numbers are test starting points, not production capacity claims. Staging load results must record P50/P95/P99, outbox age, Worker slots, provider error rates, SSE reconnects, database connections, and memory before Production sizing.

## External gates

No managed resource is created by repository code. Real Staging exit requires user-approved capacity, a Supabase project, a Hatchet Cloud tenant, private object storage, domains, secrets, and a Cloud-to-OSS switch exercise. Until then, only local, container, contract, and fault-injection results may be reported as passed.
