import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertRuntimeDatabaseRole,
  createDatabase,
} from "@infinite-canvas/db";
import { z } from "zod";

import { summarizeMigrationAudit } from "./recovery-audit-format.js";

const configSchema = z.object({
  BUSINESS_DATABASE_URL: z.url(),
  S3_REGION: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  RECOVERY_AUDIT_INCLUDE_IDENTIFIERS: z
    .enum(["true", "false"])
    .default("false"),
  RECOVERY_AUDIT_OBJECT_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4),
});

interface AssetRow {
  id: string;
  object_key: string;
  mime: string;
  bytes: string;
  sha256: string;
}

interface ActiveAttemptRow {
  attempt_id: string;
  job_id: string;
  status: string;
  executor_run_id: string | null;
  provider_task_id: string | null;
}

interface InvariantRow {
  code: string;
  violations: number;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

async function objectDigest(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ bytes: number; mime: string; sha256: string }> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!result.Body) throw new Error("object body is missing");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return {
    bytes,
    mime:
      result.ContentType?.split(";", 1)[0]?.toLowerCase() ??
      "application/octet-stream",
    sha256: hash.digest("hex"),
  };
}

async function main(): Promise<void> {
  const config = configSchema.parse(process.env);
  const database = createDatabase(config.BUSINESS_DATABASE_URL, {
    max: 4,
    applicationName: "infinite-canvas-recovery-audit",
  });
  const storage = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });

  try {
    const identity = await assertRuntimeDatabaseRole(
      database.client,
      "Recovery audit",
    );
    const snapshot = await database.client.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const migrations = await transaction<
          { name: string; sha256: string; applied_at: Date | string }[]
        >`
          select name, sha256, applied_at
          from app_schema_migrations
          order by name
        `;
        const counts = await transaction<
          {
            workspaces: number;
            projects: number;
            jobs: number;
            attempts: number;
            ready_assets: number;
            max_event_cursor: string;
          }[]
        >`
          select
            (select count(*)::int from workspaces) as workspaces,
            (select count(*)::int from projects where deleted_at is null) as projects,
            (select count(*)::int from generation_jobs) as jobs,
            (select count(*)::int from generation_attempts) as attempts,
            (select count(*)::int from assets where status = 'ready') as ready_assets,
            (select coalesce(max(sequence), 0)::text from generation_job_events) as max_event_cursor
        `;
        const invariants = await transaction<InvariantRow[]>`
          select code, violations::int
          from (
            select 'wallet_reserved_mismatch' as code, count(*) as violations
            from wallet_accounts account
            left join (
              select workspace_id, sum(amount) as amount
              from credit_reservations where status = 'reserved'
              group by workspace_id
            ) reservation on reservation.workspace_id = account.workspace_id
            where account.reserved <> coalesce(reservation.amount, 0)
            union all
            select 'attempt_reservation_cardinality', count(*)
            from (
              select attempt.id
              from generation_attempts attempt
              left join credit_reservations reservation on reservation.attempt_id = attempt.id
              group by attempt.id
              having count(reservation.id) <> 1
            ) invalid
            union all
            select 'terminal_reservation_mismatch', count(*)
            from generation_attempts attempt
            left join credit_reservations reservation on reservation.attempt_id = attempt.id
            where (attempt.status = 'succeeded' and reservation.status is distinct from 'settled'::reservation_status)
               or (attempt.status in ('failed', 'canceled') and reservation.status is distinct from 'released'::reservation_status)
            union all
            select 'active_reservation_mismatch', count(*)
            from generation_attempts attempt
            left join credit_reservations reservation on reservation.attempt_id = attempt.id
            where attempt.status in ('created', 'claimed', 'submitting', 'accepted', 'materializing', 'outcome_unknown')
              and reservation.status is distinct from 'reserved'::reservation_status
            union all
            select 'attempt_ledger_lifecycle_mismatch', count(*)
            from (
              select attempt.id, reservation.status,
                     count(entry.id) filter (where entry.kind = 'reserve') as reserve_count,
                     count(entry.id) filter (where entry.kind = 'settle') as settle_count,
                     count(entry.id) filter (where entry.kind in ('release', 'release_after_unknown_timeout')) as release_count
              from generation_attempts attempt
              left join credit_reservations reservation on reservation.attempt_id = attempt.id
              left join wallet_entries entry
                on entry.reference_type = 'attempt' and entry.reference_id = attempt.id
              group by attempt.id, reservation.status
            ) lifecycle
            where reserve_count <> 1
               or (status = 'reserved' and (settle_count <> 0 or release_count <> 0))
               or (status = 'settled' and (settle_count <> 1 or release_count <> 0))
               or (status = 'released' and (settle_count <> 0 or release_count <> 1))
            union all
            select 'succeeded_asset_mismatch', count(*)
            from generation_jobs job
            left join assets asset on asset.workspace_id = job.workspace_id and asset.id = job.output_asset_id
            where job.status = 'succeeded'
              and (asset.id is null or asset.status <> 'ready')
            union all
            select 'current_attempt_mismatch', count(*)
            from generation_jobs job
            left join generation_attempts attempt
              on attempt.workspace_id = job.workspace_id and attempt.job_id = job.id and attempt.id = job.current_attempt_id
            where attempt.id is null
            union all
            select 'unknown_deadline_invalid', count(*)
            from generation_attempts
            where status = 'outcome_unknown'
              and (outcome_unknown_at is null or release_after is null
                or release_after > outcome_unknown_at + interval '24 hours')
            union all
            select 'active_outbox_identity_mismatch', count(*)
            from outbox_events event
            join generation_jobs job on job.id = event.aggregate_id
            join generation_attempts attempt on attempt.id = job.current_attempt_id and attempt.workspace_id = job.workspace_id
            where event.topic = 'generation.job.requested'
              and event.status in ('pending', 'sending')
              and (
                event.payload->>'attemptId' is distinct from job.current_attempt_id::text
                or event.payload->>'workspaceId' is distinct from job.workspace_id::text
                or event.payload->>'jobId' is distinct from job.id::text
                or (event.dispatch_started_token is not null and event.dispatch_started_token is distinct from attempt.executor_dispatch_token)
              )
          ) checks
          order by code
        `;
        const assets = await transaction<AssetRow[]>`
          select id, object_key, mime, bytes::text, sha256
          from assets where status = 'ready'
          order by object_key
        `;
        const activeAttempts = await transaction<ActiveAttemptRow[]>`
          select attempt.id as attempt_id, job.id as job_id, attempt.status::text,
                 attempt.executor_run_id, attempt.provider_task_id
          from generation_jobs job
          join generation_attempts attempt
            on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
          where attempt.status in ('created', 'claimed', 'submitting', 'accepted', 'materializing', 'outcome_unknown')
          order by attempt.created_at, attempt.id
        `;
        const activeByStatus = await transaction<
          { status: string; count: number }[]
        >`
          select attempt.status::text, count(*)::int
          from generation_jobs job
          join generation_attempts attempt
            on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
          where attempt.status in ('created', 'claimed', 'submitting', 'accepted', 'materializing', 'outcome_unknown')
          group by attempt.status order by attempt.status
        `;
        return {
          migrations,
          counts: counts[0],
          invariants,
          assets,
          activeAttempts,
          activeByStatus,
        };
      },
    );

    const inventory = new Map<string, number>();
    let continuationToken: string | undefined;
    do {
      const page = await storage.send(
        new ListObjectsV2Command({
          Bucket: config.S3_BUCKET,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) inventory.set(object.Key, object.Size ?? -1);
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    const expectedKeys = new Set(snapshot.assets.map((asset) => asset.object_key));
    const objectChecks = await mapConcurrent(
      snapshot.assets,
      config.RECOVERY_AUDIT_OBJECT_CONCURRENCY,
      async (asset) => {
        try {
          const actual = await objectDigest(
            storage,
            config.S3_BUCKET,
            asset.object_key,
          );
          return {
            missing: false,
            mismatch:
              actual.bytes !== Number(asset.bytes) ||
              actual.mime !== asset.mime.toLowerCase() ||
              actual.sha256 !== asset.sha256,
          };
        } catch {
          return { missing: true, mismatch: false };
        }
      },
    );
    const missing = objectChecks.filter((value) => value.missing).length;
    const mismatched = objectChecks.filter((value) => value.mismatch).length;
    const orphaned = [...inventory.keys()].filter(
      (key) => !expectedKeys.has(key),
    ).length;
    const invariantFailures = snapshot.invariants.reduce(
      (sum, row) => sum + Number(row.violations),
      0,
    );
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: "read_only_no_hatchet_no_provider",
      databaseRole: identity.role,
      migrations: summarizeMigrationAudit(snapshot.migrations),
      counts: snapshot.counts,
      invariants: snapshot.invariants,
      activeAttempts: {
        byStatus: Object.fromEntries(
          snapshot.activeByStatus.map((row) => [row.status, row.count]),
        ),
        total: snapshot.activeAttempts.length,
        ...(config.RECOVERY_AUDIT_INCLUDE_IDENTIFIERS === "true"
          ? {
              items: snapshot.activeAttempts.map((row) => ({
                attemptId: row.attempt_id,
                jobId: row.job_id,
                status: row.status,
                executorRunId: row.executor_run_id,
                providerTaskId: row.provider_task_id,
              })),
            }
          : {}),
      },
      objects: {
        inventoryCount: inventory.size,
        readyAssetCount: snapshot.assets.length,
        missing,
        mismatched,
        orphaned,
      },
      pass: invariantFailures === 0 && missing === 0 && mismatched === 0,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.pass) process.exitCode = 2;
  } finally {
    storage.destroy();
    await database.client.end({ timeout: 15 });
  }
}

await main();
