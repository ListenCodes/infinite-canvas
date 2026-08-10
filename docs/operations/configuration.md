# Configuration Reference

Use the topology-specific example in `infra/compose/local`, `cloud`, or `oss` as
the canonical variable list. Populate runtime files in an external secret manager
or a host path outside Git and the synchronized knowledge base. Validate them with
`node scripts/validate-deployment-config.mjs --env-file <path>` before Compose.

## Browser-visible values

Only these values may be emitted into Web runtime configuration:

| Variable | Purpose |
|---|---|
| `CLOUD_BACKEND_ENABLED` | Enables authenticated cloud project and task UI |
| `API_BASE_URL` | Public HTTPS API base URL |
| `SUPABASE_URL` | Public Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/publishable key |

Provider credentials, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_MASTER_KEY`,
database URLs/passwords, `HATCHET_CLIENT_TOKEN`, object-store secrets, and the
metrics token are server-only. The release gate scans both the built bundle and
generated Web runtime configuration with canaries.

## Database connections

| Variable | Consumer and rule |
|---|---|
| `BUSINESS_DATABASE_PROVISION_URL` | Short-lived role provisioner; may create/alter roles |
| `BUSINESS_DATABASE_MIGRATION_URL` | Direct connection as the non-superuser object owner |
| `BUSINESS_DATABASE_OBJECT_OWNER_ROLE` | Exact owner used for default privileges |
| `BUSINESS_DATABASE_URL_API` | API runtime pool connection; non-owner, non-`BYPASSRLS` |
| `BUSINESS_DATABASE_LISTENER_URL` | API direct/session connection reserved for LISTEN/NOTIFY |
| `BUSINESS_DATABASE_URL_WORKER` | Worker runtime pool connection; non-owner, non-`BYPASSRLS` |
| `BUSINESS_DATABASE_URL_RECOVERY_AUDIT` | Read-only audit login on a direct connection |

API and Worker startup reject superuser, table-owner, or `BYPASSRLS` identities.
Do not use a transaction-pooler URL for `BUSINESS_DATABASE_LISTENER_URL`.

## API and storage

The API requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, a base64-encoded
32-byte `CREDENTIAL_MASTER_KEY`, `CORS_ALLOWED_ORIGINS`, and `STORAGE_BUCKET`.
Compose maps `S3_BUCKET` to `STORAGE_BUCKET`. Optional limits include
`MAX_UPLOAD_BYTES`, `MAX_IMPORT_BYTES`, `MAX_CONCURRENT_IMPORTS`,
`MAX_IMAGE_PIXELS`, `MAX_MEDIA_DURATION_SECONDS`, `IDEMPOTENCY_TTL_SECONDS`,
`ADMIN_LARGE_DEBIT_THRESHOLD`, and `SSE_CURSOR_SCAN_MS` (default 5000).

The Worker uses the same Supabase service identity and credential master key plus
`S3_REGION`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
`S3_SECRET_ACCESS_KEY`. Keep buckets private and enable versioning for production
recovery. Set `S3_FORCE_PATH_STYLE=true` only for a compatible endpoint that needs
it.

## Hatchet

Set `HATCHET_MODE=cloud`, `oss`, or `lite`. Production rejects Lite. Cloud normally
derives endpoints from `HATCHET_CLIENT_TOKEN`; OSS/Lite require both
`HATCHET_CLIENT_HOST_PORT` and `HATCHET_CLIENT_API_URL`. Lite uses
`HATCHET_CLIENT_TLS_STRATEGY=none`; Cloud/OSS default to TLS, with certificate,
private-key, root-CA, and server-name variables available for mTLS.

`HATCHET_NAMESPACE`, `HATCHET_WORKER_SLOTS`, and `HATCHET_DURABLE_SLOTS` control
registration and concurrency. Run exactly one enabled Outbox dispatcher and one
unknown reconciler per environment by coordinating `OUTBOX_DISPATCHER_ENABLED` and
`UNKNOWN_RECONCILER_ENABLED` across Worker revisions.

## Observability and limits

`METRICS_BEARER_TOKEN` must contain at least 32 random characters whenever API
metrics are not loopback-only. Store it in the Prometheus credentials file, not in
Prometheus YAML. API, Worker, PostgreSQL, Hatchet, and object-store clocks must be
UTC-synchronized. Record every production override and its reason with the release
evidence; an example default is not a capacity claim.
