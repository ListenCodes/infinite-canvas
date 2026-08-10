# Database Migration Runbook

Migrations are ordered across `packages/db/migrations/drizzle` and
`packages/db/migrations/custom` by the append-only
`packages/db/migrations/order.txt`. `app_schema_migrations` stores a SHA-256
checksum for every applied file; changing an applied migration is a release
blocker.

## Rules

- Add forward migrations. Never edit a migration that reached any shared database.
- Append every generated/custom SQL file to `order.txt`. Never insert or reorder a
  line after release. The runner rejects missing, unlisted, unknown, checksum-drifted,
  and non-prefix histories before it applies new SQL.
- Use expand/contract: add nullable columns/functions/policies first, deploy
  compatible code, backfill, then enforce constraints in a later release.
- Keep migration owner and runtime roles separate. API and Worker must be non-owner,
  non-`BYPASSRLS` logins.
- Test RLS with real runtime logins, including forged GUC values and cross-tenant
  reads/writes.
- Back up the database and record the latest event sequence and migration checksum
  before a production migration.

## Candidate procedure

```bash
npm ci
npm run db:generate
npm run typecheck
npm test
TEST_POSTGRES_ADMIN_URL=postgresql://... npm run test:postgres
BUSINESS_DATABASE_MIGRATION_URL=postgresql://... npm run db:migrate
BUSINESS_DATABASE_PROVISION_URL=postgresql://... \
BUSINESS_DATABASE_OBJECT_OWNER_ROLE=migration_owner npm run db:provision-roles
```

For an empty database, the external role provisioner must first create the ordinary
`NOSUPERUSER NOBYPASSRLS` object-owner login and make it the database owner. Run the
schema migration with that object-owner connection, then run `db:provision-roles`
with the separate role-provisioner connection to create/repair runtime logins,
current grants, and default privileges. Provisioning cannot run before the schema
exists because it audits and grants existing `public` tables and `app` functions.

For an existing shared database, apply the append-only migration with the existing
object owner and rerun `db:provision-roles` afterward. Existing default privileges
cover objects created during the migration; the final provision pass repairs and
audits current-object grants. Never run either command with an API or Worker URL.

`npm run db:generate` must report no unexpected schema diff after a committed
custom migration. A generated SQL file is intentionally rejected until it is
reviewed and appended to `order.txt`. Run migrations against an empty database and
an upgraded copy of the previous release. Confirm `app_schema_migrations`
checksums, composite foreign keys, RLS flags, triggers, and runtime grants.
`profiles` and `workspace_members` intentionally use RLS without `FORCE`: their
SECURITY DEFINER authorization helpers are owned by the non-BYPASS object owner.
Runtime startup rejects table owners and `BYPASSRLS` logins; every other business
table is forced through RLS.

Capacity migrations are an explicit staged-upgrade case. Runtime roles may already
exist before `provider_channel_capacity_policies`,
`provider_channel_capacity_leases`, and `generation_capacity_rate_windows` are
created, so object-owner default privileges must grant API/Worker write access and
recovery-audit read-only access to future tables. The upgrade test migrates through
the pre-capacity prefix, provisions roles, inserts a legacy attempt and Outbox row,
then applies the remaining migrations and verifies snapshot/payload backfill and
restored FORCE RLS. Run this path against real PostgreSQL before promotion; PGlite
coverage is engineering evidence only.

The capacity expand migration installs its insert trigger before the new snapshot
columns become `NOT NULL`. A legacy writer that omits all five capacity fields is
filled from the latest channel/capability policy in the same INSERT; current writers
must supply a complete snapshot that matches the referenced policy. Partial or
mismatched snapshots fail closed. This trigger is the rolling-compatibility bridge,
not permission to keep legacy API writers indefinitely.

`custom/0014_versioned_outbox_claim.sql` preserves the legacy two-argument
`app.claim_outbox` signature but restricts its generation rows to workflow contract
1. Current Workers call the three-argument overload with contract 2. Apply this
expand migration before running old and new dispatchers together; it prevents
either revision from consuming the other's generation payload during drain.

## Rollback policy

`npm run db:rollback` is destructive and is only suitable for disposable initial
environments. Production rollback normally means application rollback while the
expanded schema stays in place. A destructive down migration requires a restored
backup in an isolated database, explicit data-loss approval, and reconciliation of
wallet, reservation, event, and object state before traffic resumes.

The Hatchet backend first appears in the unreleased tree after `33c86858`; no
upgrade from an older public business schema exists. Before the first release,
discard any disposable preview database created from an earlier draft and perform
a clean install. Once a release containing `order.txt` reaches a shared database,
all later changes are forward-only and must be tested from a restored copy of that
release.
