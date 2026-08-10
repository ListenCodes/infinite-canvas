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
`npm run recovery:drill` with the synthetic control-plane marker and proves the
repeatable source-to-empty-target restore mechanics, RLS/read-only roles, ledger
and reservation invariants, full object-version history, Hatchet schema/config,
and business-job reconciliation. A release candidate must additionally restore and
query a recorded terminal run through the selected Hatchet OSS backup or managed
recovery procedure. Production promotion also requires a separately recorded restore from the selected managed
Supabase/object-storage backups and the selected Hatchet Cloud retention/export or
OSS backup path. A lower tier must never be reported as satisfying a higher tier.

Mock providers, accelerated clocks, local Hatchet, and isolated PostgreSQL are valid
repeatable engineering evidence, but must be labelled. They do not replace provider
billing, managed Supabase, Hatchet Cloud outage, public TLS/SSE, alert delivery, or
full restore exercises. Any failed or missing row blocks production promotion.

## Current repeatable local evidence

The commit containing this section has the following local evidence on 2026-08-10:

- `npm test` passes 65 workspace tests. The API, Worker, and database suites each
  expose one real-PostgreSQL integration entry, but those three entries are skipped
  by the normal unit command when `TEST_POSTGRES_ADMIN_URL` is absent.
- The Web suites pass 43 tests across legacy media adapters, canvas terminal-state
  handling, cloud recovery/SSE, and local-to-cloud migration safety. The migration
  tests cover account/workspace isolation, two-phase activation, fail-closed media
  export, ordered retry-key persistence, and rollback of standalone media and text
  assets without deleting the original local archive.
- Root and Web type checks and production builds pass. Root and Web production
  dependency audits report zero known vulnerabilities. Deployment/recovery policy
  tests pass 17 scenarios, and the deployment, recovery-boundary, Web bundle secret,
  and diff checks pass.
- Rows 8-10 include deterministic fault injection. A fake paid adapter loses its
  response after acceptance while production Executor/Repository code persists one
  `outcome_unknown`, leaves the reservation frozen, schedules 1-hour/24-hour
  reconciliation, releases once with one risk entry, and ignores a late success after
  release. Object-write recovery and completion replay each produce one logical
  materialization/asset/settlement at their tested boundary.
- Rows 11-12 include HTTP SSE replay with `Last-Event-ID`, a two-instance broker test
  where one instance loses NOTIFY and recovers by scan, EOF reconnect, and snapshot
  fallback after subscribe failure. The recovery driver dependency surface has no
  create/submit operation.
- Row 14 includes a built-bundle/runtime-config canary scan, representative Fastify
  response/header canary tests, and real Pino output tests for structured credentials
  and Error message/stack redaction.

These are engineering-tier results, not production evidence. `npm run test:postgres`
fails closed without `TEST_POSTGRES_ADMIN_URL`; Docker/Hatchet/S3 restore tests and a
real browser storage/network capture were not available on this workstation. Rows
1-15 therefore remain production-blocking until their stated PostgreSQL, container,
browser, Staging, managed-service, provider-billing, outage, and restore evidence is
recorded against an immutable release candidate.
