# Backup and Restore Runbook

The recovery unit is the business database, private objects, Hatchet control-plane
state, application configuration, and immutable release manifest. A successful
backup job is not a successful restore test.

## Targets and minimum policy

| Target | Backup | Minimum verification |
|---|---|---|
| Business PostgreSQL | Managed PITR plus daily logical/schema export | Restore to isolated DB; migrations, RLS, wallet invariants |
| Object storage | Versioning, lifecycle protection, daily inventory | Sample hashes and full inventory reconciliation |
| Hatchet Cloud | Provider retention/export capability plus business run IDs | Reconcile business attempts after simulated control-plane loss |
| Hatchet OSS PostgreSQL/config | Daily encrypted backup before upgrades | Restore pinned Hatchet version and query existing runs |
| Secrets/config | External secret-manager backup and recovery access test | Names/versions only in evidence; never secret values |
| Release | `release-images.json`, convenience `release-images.env`, source SHA, migrations, workflow versions | Validate the manifest schema and pull all three images by digest on both target architectures |

Production owners must set environment-specific RPO, RTO, retention, encryption,
off-site copy, alert recipient, and legal retention before cutover. Recommended
starting targets are RPO 15 minutes and RTO 4 hours for business PostgreSQL, daily
object inventory, and a quarterly full restore exercise.

## Consistent checkpoint

1. Pause new generation and import creation; keep running Workers and SSE available.
2. Drain submitting transactions, then record UTC time, maximum
   `generation_job_events.sequence`, pending/sending Outbox IDs, active attempt IDs,
   wallet totals, and current migration checksums.
3. Start PostgreSQL/PITR and object-inventory checkpoints. For OSS, also back up the
   Hatchet database and generated config volume.
4. Record immutable image digests and workflow versions. Resume writes after the
   provider reports successful checkpoints.

Do not put database dumps, object exports, or secrets in Git or the synchronized
knowledge base.

## Automated local combined-restore drill

The release gate runs the repository-owned drill against two independently named
Compose projects: a populated source and a new empty target. It restores the
business PostgreSQL dump, every object version and delete marker, the Hatchet
PostgreSQL dump, and the complete Hatchet `/config` volume before running the
read-only audit and current-job reconciliation.

Build the candidate API and Worker images first, then run:

```bash
API_IMAGE=infinite-canvas-api:gate \
WORKER_IMAGE=infinite-canvas-worker:gate \
npm run recovery:drill -- --evidence-dir /secure/recovery-evidence
```

Docker with Compose v2 is required. The script allocates loopback-only random
ports and an internal network, does not define an API or business Worker service,
and never starts a Dispatcher or Reconciler. Raw dumps, object bodies, generated
passwords, and Hatchet configuration remain in the operating-system temporary
directory and are removed in `finally`; the selected evidence directory receives
only the redacted `combined-restore.json`. Use an evidence path outside Git and the
synchronized knowledge base.

The drill mints a one-hour Hatchet token inside the source control-plane container,
passes it to a one-shot probe container through a temporary Compose secret, and
runs the pure `infinite-canvas-recovery-terminal-probe-v1` task to `COMPLETED`.
The source business fixture records that real run ID on its succeeded attempt.
After restoring both databases and `/config`, the target uses a separate verifier
entrypoint whose code has no worker registration or trigger path. It queries REST
and gRPC for the same run, workflow version, task ID, terminal timestamp, and
input/output hashes, and requires the complete run inventory to be byte-for-byte
unchanged before and after verification. Hatchet Lite does not provide a scoped
read-only token for this fixed version, so the separate entrypoint plus inventory
check is the enforced local boundary. The token, nonce, and raw input/output never
enter argv, environment values, Git, evidence, or the synchronized knowledge base;
only redacted hashes and IDs are written to `combined-restore.json`.

This local Hatchet Lite proof closes the repository-owned OSS control-plane
invariant. It does not replace a release-candidate exercise against the selected
managed Hatchet/Supabase recovery path or production object storage.

A failed local drill retries teardown for both exact Compose projects and verifies
that no project-labelled container, volume, or network remains. A cleanup failure
is reported as a gate failure and must be resolved before reusing the runner.
Preserve only the redacted report from a successful run.

## Isolated restore

1. Create an isolated network, empty business database, private bucket, and pinned
   Hatchet environment. Disable all provider egress and dispatchers.
2. Restore the business DB using the migration-owner role. Restore objects with
   original keys, content types, byte sizes, and SHA-256 metadata.
3. Restore Hatchet OSS state where applicable. For Hatchet Cloud loss, create a new
   tenant but do not trigger business Outbox rows yet.
4. Run migrations forward to the candidate version, provision runtime roles, and
   run real-PostgreSQL RLS/CAS/ledger tests.
5. Run the read-only recovery audit before starting API, Worker, Dispatcher, or
   Reconciler. The audit executable imports no Hatchet or provider client and has
   no object-store write command:

   ```bash
   docker compose --env-file infra/compose/local/.env.example \
     -f infra/compose/local/compose.yaml --profile recovery \
     run --rm recovery-audit
   ```

   Use the Cloud or OSS Compose file for the corresponding isolated topology.
   Outside Compose, load only the variables in
   `infra/env/recovery-audit.env.example` and run `npm run recovery:audit`.
   Exit code `2` means a ledger, attempt/job, ready-object size, MIME, or SHA-256
   invariant failed. The audit downloads every ready object to hash it, so size
   storage egress and runtime accordingly. Orphan objects are reported but do not
   fail the audit; classify and quarantine them before any deletion.
6. Reconcile every current attempt:
   - `created/claimed` with no provider submission is explicitly classified for a
     controlled same-token re-dispatch;
   - `submitting` without authoritative acceptance becomes `outcome_unknown`;
   - `accepted` requires and resumes by provider task ID;
   - `materializing` requires a provider task ID or frozen media evidence, first
     HEADs the deterministic object key, then resumes download or settlement without
     another provider create;
   - terminal attempts must have exactly one matching reservation outcome and at
     most one ready output asset.
7. Compare object inventory to ready assets and evidence metadata. Quarantine orphan
   objects; do not delete during the restore exercise.
8. Compare every active attempt reported by the audit with the restored Hatchet
   run. Set `RECOVERY_AUDIT_INCLUDE_IDENTIFIERS=true` only when the report is being
   written to the approved recovery-evidence location. A missing or ambiguous
   Hatchet run remains a failed release gate; the business/object audit cannot
   substitute for control-plane evidence.
9. Start API first. Start a Worker only after network policy proves provider egress
   is denied and both Dispatcher and Reconciler are disabled. Validate snapshots
   and SSE, then enable one Dispatcher in a separate controlled convergence step.

## Required evidence

Capture source and restored timestamps, RPO/RTO, the JSON audit output, maximum
cursor, migration checksum list, object mismatch classification, Hatchet run
reconciliation, secret access test, immutable `release-images.json`, and final
operator sign-off. Redact connection strings, tokens, signed URLs, user content,
and provider payloads. Do not store recovery reports in Git or the synchronized
knowledge base.

Managed Supabase and Hatchet Cloud recovery claims require provider-side evidence.
Local logical dumps or an OSS exercise cannot be reported as proof that a managed
control plane was restored.
