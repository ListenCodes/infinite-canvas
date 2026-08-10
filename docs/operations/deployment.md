# Deployment Runbook

This runbook covers the Hatchet-backed Web, API, Worker, business PostgreSQL,
object storage, and monitoring stack. The legacy static-only deployment remains
a separate rollback target until the cloud cutover is accepted.

## Supported topologies

| Topology       | Compose file                          | Hatchet                              | Business data                                                       |
| -------------- | ------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| Local          | `infra/compose/local/compose.yaml`    | Hatchet Lite                         | Local Supabase CLI or explicitly configured development Supabase    |
| Managed        | `infra/compose/cloud/compose.yaml`    | Hatchet Cloud                        | Managed Supabase PostgreSQL/Auth/Storage or compatible S3           |
| Self-hosted    | `infra/compose/oss/compose.yaml`      | Hatchet OSS v0.101.12                | Managed or separately operated PostgreSQL and S3-compatible storage |
| Recovery drill | `infra/compose/recovery/compose.yaml` | Hatchet Lite v0.101.12 source/target | Isolated PostgreSQL 17 and versioned Moto S3 source/target          |

Application and Hatchet databases must be separate databases and runtime roles.
`BUSINESS_DATABASE_LISTENER_URL` must use a direct or session connection because
transaction pooling cannot preserve `LISTEN` state.

## Required inputs

1. Obtain `release-images-<commit>` from the Service images workflow. It contains
   immutable `WEB_IMAGE`, `API_IMAGE`, and `WORKER_IMAGE` digest references.
2. Choose an environment example from `infra/compose/<topology>/.env.example`.
   Keep the populated file outside Git and the synchronized knowledge base.
   Use `docs/operations/configuration.md` for variable ownership and secret
   boundaries.
3. Provision separate role-provisioner, object-owner/migration, API, and Worker
   database logins. Only the short-lived provisioner may create/alter roles.
   Runtime logins must not own tables and must not have `BYPASSRLS`.
4. Create a private object bucket. Block public listing and public object access.
5. Create a Hatchet tenant/token. The token belongs only in the Worker secret
   store, never Web, API responses, logs, or documentation.
6. Generate a separate random `METRICS_BEARER_TOKEN` of at least 32 characters.
   Store the same value in a root-readable Prometheus credentials file; do not
   place the value in Prometheus YAML, Git, or the knowledge base.
7. Configure TLS and an SSE-capable reverse proxy for Web and API. Disable proxy
   buffering for `/v1/events`; allow long-lived connections and `Last-Event-ID`.

Validate the candidate without printing secret values:

```bash
node scripts/validate-deployment-config.mjs --env-file /secure/path/release.env
docker compose --env-file /secure/path/runtime.env -f infra/compose/cloud/compose.yaml config --quiet
```

Before promoting a release candidate, run the combined source-to-empty-target
restore described in `docs/operations/backup-restore.md`. CI runs its repeatable
real terminal Hatchet Lite tier automatically; the selected OSS/managed-service
recovery exercises remain production evidence gates.

## Database initialization

Run tools from the same immutable API image that will be deployed:

```bash
docker compose --env-file /secure/path/runtime.env -f infra/compose/cloud/compose.yaml run --rm database-provision-roles
docker compose --env-file /secure/path/runtime.env -f infra/compose/cloud/compose.yaml run --rm database-migrate
```

The migration connection must be direct and owned by the object-owner role. Role
provisioning uses the separate `BUSINESS_DATABASE_PROVISION_URL` and names the
owner with `BUSINESS_DATABASE_OBJECT_OWNER_ROLE`; do not expose that connection
to API or Worker. The API and Worker perform a startup assertion that rejects
owner or `BYPASSRLS` roles. Never fall back from
`BUSINESS_DATABASE_MIGRATION_URL` to a runtime URL.

## Start order

1. Confirm database, Auth, bucket, and Hatchet health.
2. Apply expand-only migrations and provision grants.
3. Start API and one compatible Worker with dispatch/reconciliation disabled.
4. Verify `/healthz`, `/readyz`, Worker `/health`, and metrics from the private
   monitoring network.
5. Enable the new Worker revision, then enable one dispatcher and one unknown
   reconciler per environment.
6. Start Web and run authenticated smoke tests: bootstrap, project create/update,
   upload/complete/download, one image job, one video job, SSE reconnect, and task
   snapshot recovery.
7. Record revision, the validated `release-images.json` (including three image and
   per-platform digests), migration checksums, Hatchet workflow
   versions, smoke results, and rollback references in the release evidence file.
   The canonical manifest records the stable workflow run ID but excludes the
   mutable run-attempt number so an unchanged release can be rerun byte-for-byte.

For a tag build, the workflow creates a draft GitHub Release containing the complete
three-image manifest before it writes any immutable SHA or version tag. A failed
promotion rerun downloads and reuses that persisted set even if a rebuild would
produce different bytes. Operators and deployment automation must treat only a
published Release with both manifest files as ready; candidate tags and a draft
Release are not a deployment signal.
Manual `workflow_dispatch` runs build and validate candidate manifests but publish
neither `sha-<commit>` nor release tags. Only a tag-push run may create immutable
deployment tags after its draft Release has persisted the complete three-image set.
The combined-restore drill is then rerun against the exact API and Worker digest
references from that manifest. Its redacted evidence records the manifest SHA-256
and all three image references, plus one real terminal Hatchet run observed before
and after restoration through both REST and gRPC. Every promotion attempt executes
a fresh drill. The first report keeps the canonical `combined-restore.json` name;
a later successful rerun appends an attempt-qualified report instead of replacing
prior evidence. Reports are retained with the published Release instead of relying
on the short-lived Actions artifact alone.

For OSS, Compose waits for `hatchet-engine:/ready` and
`hatchet-dashboard:/api/ready` before starting the Worker. The dashboard embeds
the REST API in v0.101.12; `HATCHET_CLIENT_API_URL=http://hatchet-dashboard` is
intentional. Do not expose engine gRPC, Hatchet PostgreSQL, or internal metrics
directly to the Internet.

The release gate also renders `infra/compose/oss/smoke.override.yaml`, starts the
pinned split engine/dashboard stack from an empty volume, mints a one-hour token,
and runs the repository terminal probe from the non-root Worker image. The probe
shares only an internal Hatchet network and receives no business database, object
storage, Supabase service, or provider credentials. Its redacted terminal-run
observation and Compose logs are retained as `oss-hatchet-smoke-<commit>`; this CI
evidence validates startup and SDK connectivity but does not replace the selected
production OSS backup/restore exercise.

## Health and security checks

```bash
curl --fail http://127.0.0.1:3001/healthz
curl --fail http://127.0.0.1:3001/readyz
curl --fail http://127.0.0.1:8733/health
```

Also verify:

- containers run as non-root and drop all Linux capabilities;
- public Web configuration contains only API URL, Supabase URL, anon key, and
  analytics IDs;
- API/Worker secrets are injected at runtime and absent from image history;
- signed object URLs expire and cross-workspace signing returns 404/403;
- Web/API origins and CORS exactly match the production hostnames;
- Prometheus/Grafana bind to loopback or a private network.
- the public reverse proxy rejects `/metrics`; Prometheus supplies the metrics
  bearer token from its read-only credentials file.

## Verification boundary

Repository type checks, tests, image builds, Compose parsing, and secret scans are
release prerequisites, not proof of a production deployment. Managed Supabase,
Hatchet Cloud, public TLS/SSE, provider billing behavior, multi-architecture
runtime health, and alert delivery require a recorded Staging exercise.
