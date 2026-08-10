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
