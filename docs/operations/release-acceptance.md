# Release Acceptance and Evidence

Every tagged release runs unit/type/build/audit, browser secret scans, real PostgreSQL
integration tests, three image builds, Compose parsing, non-root checks, and final
multi-architecture manifest verification. A production release additionally needs
the Staging evidence below. Record evidence in the project knowledge base; do not put
secrets, signed URLs, or user content in it.

For each row record candidate source SHA, three image digests, environment, UTC time,
operator/reviewer, procedure or test name, evidence URI, result, and limitations.

| # | Blocking scenario | Minimum evidence |
|---|---|---|
| 1 | Tenant isolation | Two real users; project/asset/job/event/wallet read/write/sign/SSE rejection matrix |
| 2 | Forged authority | HTTP request and stored DB values for workspace/owner/role/price/channel forgery |
| 3 | Ten identical keys | One batch, three jobs/reservations, at most three provider creates |
| 4 | Three images, two fail | Per-slot UI/errors; success preserved; exactly two new retry attempts |
| 5 | Browser close/relogin | Authenticated snapshot reaches terminal state without a new submit |
| 6 | Four video refresh windows | Before/after task ID, polling, download; resume or explicit unknown |
| 7 | Moderation 400 | Stable non-network error and one provider call |
| 8 | Lost paid response | One create, unknown state, frozen reservation, reconciliation entry |
| 9 | Unknown deadlines | 1-hour check; <=24-hour settle/release; risk entry; no clawback |
| 10 | Three Worker crash points | Provider success, object write, pre-settle; one object/asset/settlement |
| 11 | Two API SSE replicas | Both receive; dropped NOTIFY recovered by cursor scan; no resubmit |
| 12 | Last-Event-ID recovery | Ordered replay; snapshot fallback when cursor expired; no resubmit |
| 13 | Hatchet Cloud 30-minute outage | One Outbox record; recovery CAS; no duplicate provider/ledger effect |
| 14 | Secret boundary | Deployed bundle/storage/responses/logs scanned with canaries and patterns |
| 15 | Combined restore | Business DB, objects, Hatchet state restored and every current job reconciled |

Row 15 has three explicit evidence tiers. The release-gate CI tier runs
`npm run recovery:drill` with a real terminal Hatchet Lite run and proves the
repeatable source-to-empty-target restore mechanics, RLS/read-only roles, ledger
and reservation invariants, full object-version history, Hatchet schema/config,
and business-job reconciliation against that same run through REST and gRPC. A
release candidate must repeat the restore through the selected Hatchet OSS backup
or managed recovery procedure. Production promotion also requires a separately
recorded restore from the selected managed
Supabase/object-storage backups and the selected Hatchet Cloud retention/export or
OSS backup path. A lower tier must never be reported as satisfying a higher tier.

Mock providers, accelerated clocks, local Hatchet, and isolated PostgreSQL are valid
repeatable engineering evidence, but must be labelled. They do not replace provider
billing, managed Supabase, Hatchet Cloud outage, public TLS/SSE, alert delivery, or
full restore exercises. Any failed or missing row blocks production promotion.

## Current repeatable local evidence

The commit containing this section has the following local evidence on 2026-08-10:

- `npm test` passes 87 workspace tests and skips three environment-gated entries.
  The API, Worker, and database suites each expose one real-PostgreSQL integration
  entry; those three entries are skipped by the normal unit command when
  `TEST_POSTGRES_ADMIN_URL` is absent.
- The Web suites pass 44 tests across legacy media adapters, canvas terminal-state
  handling, cloud recovery/SSE, and local-to-cloud migration safety. The migration
  tests cover account/workspace isolation, two-phase activation, fail-closed media
  export, ordered retry-key persistence, and rollback of standalone media and text
  assets without deleting the original local archive.
- Root and Web type checks and production builds pass. Root and Web production
  dependency audits report zero known vulnerabilities. Deployment/recovery policy
  tests pass 29 scenarios, and the deployment, recovery-boundary, Web bundle secret,
  isolated-browser storage secret, and diff checks pass.
- Capacity tests cover v1/v2 contract separation, immutable attempt snapshots,
  old-prefix migration backfill, append-only channel policy, workspace 3/2 and
  dynamic channel leases, provider-request-only RPM consumption, retained unknown
  leases, stale reconciliation claim recovery, cancel evidence, and deterministic
  terminal release. The v1/v2 runbook pauses generation writes, proves v1 drain,
  and uses an explicitly validated zero-owner handoff before v2 starts. Multi-
  connection PostgreSQL and real Hatchet fairness/load evidence remains an external
  release row, not a local pass.
- Rows 8-10 include deterministic fault injection. A fake paid adapter loses its
  response after acceptance while production Executor/Repository code persists one
  `outcome_unknown`, leaves the reservation frozen, schedules 1-hour/24-hour
  reconciliation, releases once with one risk entry, and ignores a late success after
  release. A provider success found by the 1-hour reconciliation path is carried by a
  fresh execution claim through materialization to one asset and one settlement in the
  real-PostgreSQL suite. Object-write recovery and completion replay each produce one
  logical materialization/asset/settlement at their tested boundary. S3 protocol tests
  require exact SHA-256, size, MIME, and kind evidence before accepting a deterministic
  `HEAD` recovery or `412 PreconditionFailed` replay. The container recovery drill also
  sends real AWS SDK requests to Moto and requires the first conditional write, second
  `412`, and immutable HEAD metadata round trip before taking its source checkpoint.
- Rows 11-12 include HTTP SSE replay with `Last-Event-ID`, a two-instance broker test
  where one instance loses NOTIFY and recovers by scan, EOF reconnect, and snapshot
  fallback after subscribe failure. The recovery driver dependency surface has no
  create/submit operation.
- Row 14 includes a built-bundle/runtime-config canary scan, representative Fastify
  response/header canary tests, and real Pino output tests for structured credentials
  and Error message/stack redaction. A fresh isolated headless browser loads the built
  Web application and recursively scans local storage, session storage, and IndexedDB;
  injected probes prove that every storage layer is actually inspected.
- Runtime database ACL tests revoke the default public execute privilege from all
  write-capable `SECURITY DEFINER` helpers. The recovery-audit role retains only
  read access and the four RLS identity helpers. Migration ledger entries bind both
  checksum and ordered prefix, preventing a previously applied manifest from being
  silently reordered.
- Capacity-policy tests cover append-only policy versions, immutable attempt
  snapshots, legacy attempt/Outbox backfill, FORCE RLS restoration, channel lease
  validation, workspace/channel minute counters, terminal release, stale dispatch
  fencing, and the image workspace limit of three. Normal dispatch excludes
  `outcome_unknown`; provider-task reconciliation uses the same database capacity
  gate. Real PostgreSQL contention and provider load evidence remain required.
- Tag publication first persists one three-image release set in a draft GitHub
  Release, then promotes immutable tags from that set. The combined recovery evidence
  is regenerated against the exact API/Worker digests, records the manifest checksum
  and all three image references, and requires the same real terminal Hatchet run,
  task identity, terminal timestamp, and input/output hashes before and after the
  control-plane restore. Promotion always executes a fresh drill; workflow reruns
  append attempt-qualified evidence and never treat an existing Release JSON asset
  as proof of execution. Evidence is retained with the published Release. Cloud and OSS
  include validated old/new Worker drain overlays whose dispatcher and
  reconciler flags must each have exactly one owner outside the intentional zero-owner
  handoff interval.

These are engineering-tier results, not production evidence. `npm run test:postgres`
fails closed without `TEST_POSTGRES_ADMIN_URL`; Docker/Hatchet restore tests, a real
S3-compatible service exercise, and deployed-browser network capture were not
available on this workstation. Rows 1-15 therefore remain production-blocking until
their stated PostgreSQL, container, browser, Staging, managed-service,
provider-billing, outage, and restore evidence is recorded against an immutable
release candidate.
