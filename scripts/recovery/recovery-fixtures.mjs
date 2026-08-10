import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";

export const fixtureIds = Object.freeze({
  userA: "10000000-0000-4000-8000-000000000001",
  userB: "10000000-0000-4000-8000-000000000002",
  workspaceA: "10000000-0000-4000-8000-000000000101",
  workspaceB: "10000000-0000-4000-8000-000000000102",
  projectA: "10000000-0000-4000-8000-000000000201",
  projectB: "10000000-0000-4000-8000-000000000202",
  channel: "10000000-0000-4000-8000-000000000301",
  model: "10000000-0000-4000-8000-000000000401",
  idempotency: "10000000-0000-4000-8000-000000000501",
  idempotencyB: "10000000-0000-4000-8000-000000000502",
  batch: "10000000-0000-4000-8000-000000000601",
  batchB: "10000000-0000-4000-8000-000000000602",
  succeededJob: "10000000-0000-4000-8000-000000000701",
  activeJob: "10000000-0000-4000-8000-000000000702",
  failedJobB: "10000000-0000-4000-8000-000000000703",
  redispatchJob: "10000000-0000-4000-8000-000000000704",
  claimedRedispatchJob: "10000000-0000-4000-8000-000000000705",
  succeededAttempt: "10000000-0000-4000-8000-000000000801",
  activeAttempt: "10000000-0000-4000-8000-000000000802",
  failedAttemptB: "10000000-0000-4000-8000-000000000803",
  redispatchAttempt: "10000000-0000-4000-8000-000000000804",
  claimedRedispatchAttempt: "10000000-0000-4000-8000-000000000805",
  asset: "10000000-0000-4000-8000-000000000901",
  assetB: "10000000-0000-4000-8000-000000000902",
  succeededReservation: "10000000-0000-4000-8000-000000001001",
  activeReservation: "10000000-0000-4000-8000-000000001002",
  failedReservationB: "10000000-0000-4000-8000-000000001003",
  redispatchReservation: "10000000-0000-4000-8000-000000001004",
  claimedRedispatchReservation: "10000000-0000-4000-8000-000000001005",
  reserveSucceededEntry: "10000000-0000-4000-8000-000000001101",
  settleSucceededEntry: "10000000-0000-4000-8000-000000001102",
  reserveActiveEntry: "10000000-0000-4000-8000-000000001103",
  reserveFailedBEntry: "10000000-0000-4000-8000-000000001104",
  releaseFailedBEntry: "10000000-0000-4000-8000-000000001105",
  reserveRedispatchEntry: "10000000-0000-4000-8000-000000001106",
  reserveClaimedRedispatchEntry: "10000000-0000-4000-8000-000000001107",
  eventSucceeded: "10000000-0000-4000-8000-000000001201",
  eventFailedB: "10000000-0000-4000-8000-000000001202",
});

export const fixtureBucket = "infinite-canvas-recovery";
export const fixtureObjectKey = `${fixtureIds.workspaceA}/generated/${fixtureIds.succeededAttempt}.png`;
export const fixtureProbeRunId = "recovery-probe-run-1";
export const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createRecoveryS3(endpoint) {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "recovery-drill", secretAccessKey: "recovery-drill" },
  });
}

async function streamToBuffer(body) {
  if (!body) throw new Error("S3 object body is missing");
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function pauseForVersionOrdering() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
}

export async function seedRecoveryFixtures({ businessUrl, hatchetUrl, s3Endpoint, probeRunId = fixtureProbeRunId }) {
  const storage = createRecoveryS3(s3Endpoint);
  await storage.send(new CreateBucketCommand({ Bucket: fixtureBucket }));
  await storage.send(new PutBucketVersioningCommand({
    Bucket: fixtureBucket,
    VersioningConfiguration: { Status: "Enabled" },
  }));
  await storage.send(new PutObjectCommand({
    Bucket: fixtureBucket,
    Key: fixtureObjectKey,
    Body: Buffer.from("obsolete-object-version", "utf8"),
    ContentType: "application/octet-stream",
    Metadata: { fixture: "previous" },
  }));
  await pauseForVersionOrdering();
  await storage.send(new PutObjectCommand({
    Bucket: fixtureBucket,
    Key: fixtureObjectKey,
    Body: fixturePng,
    ContentType: "image/png",
    Metadata: { fixture: "current" },
  }));
  await pauseForVersionOrdering();
  await storage.send(new PutObjectCommand({
    Bucket: fixtureBucket,
    Key: "deleted/recovery-marker.txt",
    Body: Buffer.from("delete-marker-source", "utf8"),
    ContentType: "text/plain",
  }));
  await pauseForVersionOrdering();
  await storage.send(new DeleteObjectCommand({ Bucket: fixtureBucket, Key: "deleted/recovery-marker.txt" }));

  const database = postgres(businessUrl, { max: 1, prepare: false });
  try {
    await database.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into profiles (user_id, display_name, cloud_projects_enabled, cloud_image_enabled, cloud_credits_enabled)
        values (${fixtureIds.userA}, 'Recovery A', true, true, true), (${fixtureIds.userB}, 'Recovery B', true, true, true)
      `;
      await transaction`
        insert into workspaces (id, owner_user_id, name)
        values (${fixtureIds.workspaceA}, ${fixtureIds.userA}, 'Recovery Workspace A'),
               (${fixtureIds.workspaceB}, ${fixtureIds.userB}, 'Recovery Workspace B')
      `;
      await transaction`
        insert into workspace_members (workspace_id, user_id, role)
        values (${fixtureIds.workspaceA}, ${fixtureIds.userA}, 'owner'),
               (${fixtureIds.workspaceB}, ${fixtureIds.userB}, 'owner')
      `;
      await transaction`
        insert into projects (id, workspace_id, title, document_json, updated_by)
        values (${fixtureIds.projectA}, ${fixtureIds.workspaceA}, 'Recovery Project A', '{}'::jsonb, ${fixtureIds.userA}),
               (${fixtureIds.projectB}, ${fixtureIds.workspaceB}, 'Recovery Project B', '{}'::jsonb, ${fixtureIds.userB})
      `;
      await transaction`
        insert into provider_channels (id, name, type, base_url, capabilities)
        values (${fixtureIds.channel}, 'Recovery provider', 'openai', 'https://provider.invalid', '["image"]'::jsonb)
      `;
      await transaction`
        insert into model_configs (id, channel_id, model, capability, adapter_type, adapter_version, config_version, limits_json)
        values (${fixtureIds.model}, ${fixtureIds.channel}, 'recovery-model', 'image', 'openai-images', 1, 1, '{}'::jsonb)
      `;
      await transaction`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, status, response_status, response_body, expires_at)
        values
          (${fixtureIds.idempotency}, ${fixtureIds.workspaceA}, 'batch.create', 'recovery-drill-batch', ${"a".repeat(64)}, 'completed', 202, '{}'::jsonb, now() + interval '7 days'),
          (${fixtureIds.idempotencyB}, ${fixtureIds.workspaceB}, 'batch.create', 'recovery-drill-batch-b', ${"d".repeat(64)}, 'completed', 202, '{}'::jsonb, now() + interval '7 days')
      `;
      await transaction`
        insert into generation_batches (id, workspace_id, project_id, kind, requested_count, status, idempotency_request_id, created_by)
        values
          (${fixtureIds.batch}, ${fixtureIds.workspaceA}, ${fixtureIds.projectA}, 'image', 4, 'running', ${fixtureIds.idempotency}, ${fixtureIds.userA}),
          (${fixtureIds.batchB}, ${fixtureIds.workspaceB}, ${fixtureIds.projectB}, 'image', 1, 'failed', ${fixtureIds.idempotencyB}, ${fixtureIds.userB})
      `;
      const modelSnapshot = JSON.stringify({ model: "recovery-model", adapterType: "openai-images", adapterVersion: 1 });
      const priceSnapshot = JSON.stringify({ unitCredits: "10", version: 1 });
      const succeededInput = JSON.stringify({ input: { prompt: "restore" }, target: { projectId: fixtureIds.projectA, nodeId: "node-1", slotId: "slot-1" } });
      const activeInput = JSON.stringify({ input: { prompt: "restore active" }, target: { projectId: fixtureIds.projectA, nodeId: "node-1", slotId: "slot-2" } });
      const redispatchInput = JSON.stringify({ input: { prompt: "restore queued" }, target: { projectId: fixtureIds.projectA, nodeId: "node-1", slotId: "slot-3" } });
      const claimedRedispatchInput = JSON.stringify({ input: { prompt: "restore claimed" }, target: { projectId: fixtureIds.projectA, nodeId: "node-1", slotId: "slot-4" } });
      await transaction`
        insert into generation_jobs (
          id, workspace_id, batch_id, slot_index, capability, model_config_id,
          model_snapshot, price_snapshot, input_snapshot, estimated_credits
        ) values
          (${fixtureIds.succeededJob}, ${fixtureIds.workspaceA}, ${fixtureIds.batch}, 0, 'image', ${fixtureIds.model}, ${modelSnapshot}::jsonb, ${priceSnapshot}::jsonb, ${succeededInput}::jsonb, 10),
          (${fixtureIds.activeJob}, ${fixtureIds.workspaceA}, ${fixtureIds.batch}, 1, 'image', ${fixtureIds.model}, ${modelSnapshot}::jsonb, ${priceSnapshot}::jsonb, ${activeInput}::jsonb, 10),
          (${fixtureIds.redispatchJob}, ${fixtureIds.workspaceA}, ${fixtureIds.batch}, 2, 'image', ${fixtureIds.model}, ${modelSnapshot}::jsonb, ${priceSnapshot}::jsonb, ${redispatchInput}::jsonb, 10),
          (${fixtureIds.claimedRedispatchJob}, ${fixtureIds.workspaceA}, ${fixtureIds.batch}, 3, 'image', ${fixtureIds.model}, ${modelSnapshot}::jsonb, ${priceSnapshot}::jsonb, ${claimedRedispatchInput}::jsonb, 10),
          (${fixtureIds.failedJobB}, ${fixtureIds.workspaceB}, ${fixtureIds.batchB}, 0, 'image', ${fixtureIds.model}, ${modelSnapshot}::jsonb, ${priceSnapshot}::jsonb,
           ${JSON.stringify({ input: { prompt: "tenant B" }, target: { projectId: fixtureIds.projectB, nodeId: "node-b", slotId: "slot-b" } })}::jsonb, 10)
      `;
      await transaction`
        insert into generation_attempts (
          id, workspace_id, job_id, attempt_no, channel_id, credential_version,
          adapter_type, adapter_version, request_fingerprint, business_deadline_at
        ) values
          (${fixtureIds.succeededAttempt}, ${fixtureIds.workspaceA}, ${fixtureIds.succeededJob}, 1, ${fixtureIds.channel}, 1, 'openai-images', 1, ${"b".repeat(64)}, now() + interval '30 minutes'),
          (${fixtureIds.activeAttempt}, ${fixtureIds.workspaceA}, ${fixtureIds.activeJob}, 1, ${fixtureIds.channel}, 1, 'openai-images', 1, ${"c".repeat(64)}, now() + interval '30 minutes'),
          (${fixtureIds.redispatchAttempt}, ${fixtureIds.workspaceA}, ${fixtureIds.redispatchJob}, 1, ${fixtureIds.channel}, 1, 'openai-images', 1, ${"9".repeat(64)}, now() + interval '30 minutes'),
          (${fixtureIds.claimedRedispatchAttempt}, ${fixtureIds.workspaceA}, ${fixtureIds.claimedRedispatchJob}, 1, ${fixtureIds.channel}, 1, 'openai-images', 1, ${"8".repeat(64)}, now() + interval '30 minutes'),
          (${fixtureIds.failedAttemptB}, ${fixtureIds.workspaceB}, ${fixtureIds.failedJobB}, 1, ${fixtureIds.channel}, 1, 'openai-images', 1, ${"e".repeat(64)}, now() + interval '30 minutes')
      `;
      await transaction`update generation_jobs set current_attempt_id = ${fixtureIds.succeededAttempt} where id = ${fixtureIds.succeededJob}`;
      await transaction`update generation_jobs set current_attempt_id = ${fixtureIds.activeAttempt} where id = ${fixtureIds.activeJob}`;
      await transaction`update generation_jobs set current_attempt_id = ${fixtureIds.redispatchAttempt} where id = ${fixtureIds.redispatchJob}`;
      await transaction`update generation_jobs set current_attempt_id = ${fixtureIds.claimedRedispatchAttempt}, status = 'dispatching' where id = ${fixtureIds.claimedRedispatchJob}`;
      await transaction`update generation_attempts set status = 'claimed', claimed_at = now() where id = ${fixtureIds.claimedRedispatchAttempt}`;
      await transaction`update generation_jobs set current_attempt_id = ${fixtureIds.failedAttemptB} where id = ${fixtureIds.failedJobB}`;
      await transaction`
        insert into generation_job_targets (job_id, workspace_id, project_id, node_id, slot_id)
        values (${fixtureIds.succeededJob}, ${fixtureIds.workspaceA}, ${fixtureIds.projectA}, 'node-1', 'slot-1'),
               (${fixtureIds.activeJob}, ${fixtureIds.workspaceA}, ${fixtureIds.projectA}, 'node-1', 'slot-2')
              ,(${fixtureIds.redispatchJob}, ${fixtureIds.workspaceA}, ${fixtureIds.projectA}, 'node-1', 'slot-3')
              ,(${fixtureIds.claimedRedispatchJob}, ${fixtureIds.workspaceA}, ${fixtureIds.projectA}, 'node-1', 'slot-4')
              ,(${fixtureIds.failedJobB}, ${fixtureIds.workspaceB}, ${fixtureIds.projectB}, 'node-b', 'slot-b')
      `;
      await transaction`insert into wallet_accounts (workspace_id, available) values (${fixtureIds.workspaceA}, 100), (${fixtureIds.workspaceB}, 100)`;
      await transaction`select app.reserve_credits(${fixtureIds.succeededReservation}, ${fixtureIds.reserveSucceededEntry}, ${fixtureIds.workspaceA}, ${fixtureIds.succeededJob}, ${fixtureIds.succeededAttempt}, 10, now() + interval '24 hours')`;
      await transaction`select app.settle_reservation(${fixtureIds.succeededAttempt}, ${fixtureIds.settleSucceededEntry})`;
      await transaction`select app.reserve_credits(${fixtureIds.activeReservation}, ${fixtureIds.reserveActiveEntry}, ${fixtureIds.workspaceA}, ${fixtureIds.activeJob}, ${fixtureIds.activeAttempt}, 10, now() + interval '24 hours')`;
      await transaction`select app.reserve_credits(${fixtureIds.redispatchReservation}, ${fixtureIds.reserveRedispatchEntry}, ${fixtureIds.workspaceA}, ${fixtureIds.redispatchJob}, ${fixtureIds.redispatchAttempt}, 10, now() + interval '24 hours')`;
      await transaction`select app.reserve_credits(${fixtureIds.claimedRedispatchReservation}, ${fixtureIds.reserveClaimedRedispatchEntry}, ${fixtureIds.workspaceA}, ${fixtureIds.claimedRedispatchJob}, ${fixtureIds.claimedRedispatchAttempt}, 10, now() + interval '24 hours')`;
      await transaction`select app.reserve_credits(${fixtureIds.failedReservationB}, ${fixtureIds.reserveFailedBEntry}, ${fixtureIds.workspaceB}, ${fixtureIds.failedJobB}, ${fixtureIds.failedAttemptB}, 10, now() + interval '24 hours')`;
      await transaction`select app.release_reservation(${fixtureIds.failedAttemptB}, ${fixtureIds.releaseFailedBEntry}, 'recovery_fixture_failed')`;
      await transaction`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values (${fixtureIds.asset}, ${fixtureIds.workspaceA}, 'image', 'ready', ${fixtureObjectKey}, 'image/png', ${fixturePng.byteLength}, ${sha256(fixturePng)})
      `;
      await transaction`
        update generation_attempts set status = 'succeeded', completed_at = now()
        where id = ${fixtureIds.succeededAttempt}
      `;
      await transaction`
        update generation_jobs set status = 'succeeded', output_asset_id = ${fixtureIds.asset}, version = 1, terminal_at = now()
        where id = ${fixtureIds.succeededJob}
      `;
      await transaction`
        update generation_attempts
        set status = 'accepted', provider_task_id = 'recovery-provider-task-1',
            executor_run_id = ${probeRunId}, submitted_at = now()
        where id = ${fixtureIds.activeAttempt}
      `;
      await transaction`
        update generation_jobs set status = 'waiting_provider', version = 1
        where id = ${fixtureIds.activeJob}
      `;
      await transaction`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values (${fixtureIds.assetB}, ${fixtureIds.workspaceB}, 'image', 'uploading',
                ${`${fixtureIds.workspaceB}/uploads/tenant-b.png`}, 'image/png', 8, ${"f".repeat(64)})
      `;
      await transaction`
        update generation_attempts set status = 'failed', completed_at = now(), error_code = 'fixture_failure'
        where id = ${fixtureIds.failedAttemptB}
      `;
      await transaction`
        update generation_jobs set status = 'failed', version = 1, terminal_at = now()
        where id = ${fixtureIds.failedJobB}
      `;
      await transaction`select app.refresh_generation_batch(${fixtureIds.batch})`;
      await transaction`select app.refresh_generation_batch(${fixtureIds.batchB})`;
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
        ) values (
          ${fixtureIds.workspaceA}, 'job', ${fixtureIds.succeededJob}, ${fixtureIds.projectA}, ${fixtureIds.batch},
          ${fixtureIds.succeededJob}, ${fixtureIds.succeededAttempt}, 'generation.job.state_changed',
          '{"status":"succeeded","attemptNo":1,"jobVersion":1}'::jsonb
        )
      `;
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
        ) values (
          ${fixtureIds.workspaceB}, 'job', ${fixtureIds.failedJobB}, ${fixtureIds.projectB}, ${fixtureIds.batchB},
          ${fixtureIds.failedJobB}, ${fixtureIds.failedAttemptB}, 'generation.job.state_changed',
          '{"status":"failed","attemptNo":1,"jobVersion":1}'::jsonb
        )
      `;
    });
  } finally {
    await database.end();
    storage.destroy();
  }

  const hatchet = postgres(hatchetUrl, { max: 1, prepare: false });
  try {
    await hatchet`
      create table if not exists recovery_drill_probe_runs (
        run_id text primary key,
        status text not null,
        workflow_name text not null,
        created_at timestamptz not null default now()
      )
    `;
    await hatchet`
      insert into recovery_drill_probe_runs (run_id, status, workflow_name)
      values (${probeRunId}, 'running', 'media-generation-v1')
      on conflict (run_id) do update set status = excluded.status, workflow_name = excluded.workflow_name
    `;
  } finally {
    await hatchet.end();
  }
}

export async function exportObjectVersions(client, bucket, directory) {
  await mkdir(directory, { recursive: true });
  const versions = [];
  const deleteMarkers = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }));
    versions.push(...(page.Versions ?? []));
    deleteMarkers.push(...(page.DeleteMarkers ?? []));
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);

  const keys = new Map();
  for (const item of [...versions, ...deleteMarkers]) {
    if (!item.Key || !item.VersionId) continue;
    const values = keys.get(item.Key) ?? [];
    values.push(item);
    keys.set(item.Key, values);
  }

  const manifest = { schemaVersion: 1, bucket, keys: [] };
  for (const [key, items] of [...keys.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    items.sort((left, right) => {
      if (left.IsLatest !== right.IsLatest) return left.IsLatest ? -1 : 1;
      return Number(right.LastModified ?? 0) - Number(left.LastModified ?? 0);
    });
    const history = [];
    for (const [index, item] of items.entries()) {
      const isDeleteMarker = !Object.hasOwn(item, "Size");
      if (isDeleteMarker) {
        history.push({ kind: "delete" });
        continue;
      }
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: item.VersionId }));
      const body = await streamToBuffer(object.Body);
      const bodyFile = `${sha256(Buffer.from(key)).slice(0, 24)}-${index}.bin`;
      await writeFile(resolve(directory, bodyFile), body);
      history.push({
        kind: "version",
        bodyFile,
        bytes: body.byteLength,
        sha256: sha256(body),
        contentType: object.ContentType ?? "application/octet-stream",
        metadata: object.Metadata ?? {},
      });
    }
    manifest.keys.push({ key, history });
  }
  await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function restoreObjectVersions(client, manifest, directory) {
  await client.send(new CreateBucketCommand({ Bucket: manifest.bucket }));
  await client.send(new PutBucketVersioningCommand({
    Bucket: manifest.bucket,
    VersioningConfiguration: { Status: "Enabled" },
  }));
  for (const entry of manifest.keys) {
    for (const version of [...entry.history].reverse()) {
      if (version.kind === "delete") {
        await client.send(new DeleteObjectCommand({ Bucket: manifest.bucket, Key: entry.key }));
      } else {
        const body = await readFile(resolve(directory, version.bodyFile));
        if (body.byteLength !== version.bytes || sha256(body) !== version.sha256) {
          throw new Error(`Object backup checksum mismatch for ${entry.key}`);
        }
        await client.send(new PutObjectCommand({
          Bucket: manifest.bucket,
          Key: entry.key,
          Body: body,
          ContentType: version.contentType,
          Metadata: version.metadata,
        }));
      }
      await pauseForVersionOrdering();
    }
  }
}

export function canonicalObjectManifest(manifest) {
  return manifest.keys.map(({ key, history }) => ({
    key,
    history: history.map((version) => version.kind === "delete" ? { kind: "delete" } : {
      kind: "version",
      bytes: version.bytes,
      sha256: version.sha256,
      contentType: version.contentType,
      metadata: version.metadata,
    }),
  }));
}

export async function businessManifest(url) {
  const database = postgres(url, { max: 1, prepare: false });
  try {
    const migrations = await database`select name, sha256 from app_schema_migrations order by name`;
    const jobs = await database`
      select job.id::text, job.status::text, attempt.id::text as attempt_id,
             attempt.status::text as attempt_status, attempt.executor_run_id,
             reservation.status::text as reservation_status, job.output_asset_id::text
      from generation_jobs job
      join generation_attempts attempt on attempt.id = job.current_attempt_id
      join credit_reservations reservation on reservation.attempt_id = attempt.id
      order by job.id
    `;
    const wallet = await database`select workspace_id::text, available::text, reserved::text, version from wallet_accounts order by workspace_id`;
    const entries = await database`select kind, amount::text, reference_id::text from wallet_entries order by created_at, id`;
    const assets = await database`select id::text, object_key, bytes::text, mime, sha256 from assets where status = 'ready' order by id`;
    return { migrations, jobs, wallet, entries, assets };
  } finally {
    await database.end();
  }
}

export async function verifyRestoredAccess({ adminUrl, apiUrl, recoveryUrl }) {
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  const api = postgres(apiUrl, { max: 1, prepare: false });
  const recovery = postgres(recoveryUrl, { max: 1, prepare: false });
  try {
    const visibility = await api.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', ${fixtureIds.userA}, true)`;
      await transaction`select set_config('app.service_role', 'off', true)`;
      return transaction`
        select
          (select count(*)::int from projects) as projects,
          (select count(*)::int from assets) as assets,
          (select count(*)::int from generation_jobs) as jobs,
          (select count(*)::int from generation_job_events) as events,
          (select count(*)::int from wallet_accounts) as wallets,
          (select count(*)::int from wallet_entries) as ledger
      `;
    });
    const expectedVisibility = { projects: 1, assets: 1, jobs: 4, events: 1, wallets: 1, ledger: 5 };
    if (JSON.stringify(visibility[0]) !== JSON.stringify(expectedVisibility)) {
      throw new Error("Restored API role failed tenant-isolation verification");
    }
    const crossTenantWrites = await api.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', ${fixtureIds.userA}, true)`;
      await transaction`select set_config('app.service_role', 'off', true)`;
      const projects = await transaction`update projects set title = 'forged' where id = ${fixtureIds.projectB} returning id`;
      const assets = await transaction`update assets set updated_at = now() where id = ${fixtureIds.assetB} returning id`;
      const jobs = await transaction`update generation_jobs set updated_at = now() where id = ${fixtureIds.failedJobB} returning id`;
      const wallets = await transaction`update wallet_accounts set available = available + 1 where workspace_id = ${fixtureIds.workspaceB} returning workspace_id`;
      return projects.length + assets.length + jobs.length + wallets.length;
    });
    if (crossTenantWrites !== 0) throw new Error("Restored API role modified another tenant");
    const forgedServiceRole = await admin.begin(async (transaction) => {
      await transaction.unsafe(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'infinite_canvas_recovery_attacker') then
            create role infinite_canvas_recovery_attacker nologin noinherit nosuperuser nobypassrls;
          end if;
        end $$;
        grant usage on schema public, app to infinite_canvas_recovery_attacker;
        grant select, update on projects, assets, generation_jobs, wallet_accounts to infinite_canvas_recovery_attacker;
        set session authorization infinite_canvas_recovery_attacker;
      `);
      await transaction`select set_config('app.user_id', '', true), set_config('app.service_role', 'on', true)`;
      const rows = await transaction`select count(*)::int as count from projects`;
      const changed = await transaction`update projects set title = 'forged-service' where id = ${fixtureIds.projectA} returning id`;
      await transaction.unsafe("reset session authorization");
      return { visible: rows[0]?.count ?? -1, changed: changed.length };
    });
    await admin.unsafe("drop owned by infinite_canvas_recovery_attacker; drop role infinite_canvas_recovery_attacker");
    if (forgedServiceRole.visible !== 0 || forgedServiceRole.changed !== 0)
      throw new Error("Untrusted database identity forged service-role access after restore");
    await recovery.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      const rows = await transaction`select count(*)::int as count from generation_jobs`;
      if (rows[0]?.count !== 5) throw new Error("Recovery audit role could not read restored jobs");
    });
    let writeRejected = false;
    try {
      await recovery`update generation_jobs set version = version + 1 where id = ${fixtureIds.activeJob}`;
    } catch {
      writeRejected = true;
    }
    if (!writeRejected) throw new Error("Recovery audit role unexpectedly modified restored business state");
    return {
      tenantIsolation: true,
      visibleCounts: expectedVisibility,
      crossTenantWritesRejected: true,
      forgedServiceRoleRejected: true,
      recoveryRoleReadOnly: true,
    };
  } finally {
    await Promise.all([admin.end(), api.end(), recovery.end()]);
  }
}

export function classifyRestoredJob(job, probeById) {
  const terminalAttempt = {
    succeeded: "succeeded",
    failed: "failed",
    canceled: "canceled",
  }[job.status];
  if (terminalAttempt) {
    return terminalAttempt === job.attempt_status
      ? { jobId: job.id, classification: "business_terminal", status: job.status }
      : { jobId: job.id, classification: "unreconciled", status: job.status, reason: "terminal_attempt_mismatch" };
  }
  const allowedAttemptStatuses = {
    queued: ["created"],
    dispatching: ["claimed"],
    running: ["claimed", "submitting"],
    waiting_provider: ["accepted"],
    materializing: ["materializing"],
    cancel_requested: ["created", "claimed", "submitting", "accepted", "materializing", "outcome_unknown"],
    outcome_unknown: ["outcome_unknown"],
  }[job.status] ?? [];
  if (!allowedAttemptStatuses.includes(job.attempt_status)) {
    return { jobId: job.id, classification: "unreconciled", status: job.status, reason: "job_attempt_state_mismatch" };
  }
  const hasProviderSubmission = Boolean(job.provider_task_id || job.submitted_at);
  if (!job.executor_run_id) {
    if (["created", "claimed"].includes(job.attempt_status) && !hasProviderSubmission) {
      return {
        jobId: job.id,
        classification: "redispatchable_no_provider_submission",
        status: job.status,
      };
    }
    return { jobId: job.id, classification: "unreconciled", status: job.status, reason: "missing_executor_run" };
  }
  const probe = probeById.get(job.executor_run_id);
  if (!probe || probe.status !== "running" || probe.workflow_name !== "media-generation-v1") {
    return {
      jobId: job.id,
      classification: "unreconciled",
      status: job.status,
      reason: !probe ? "missing_control_plane_run" : "control_plane_state_mismatch",
      probeStatus: probe?.status ?? null,
      workflowName: probe?.workflow_name ?? null,
    };
  }
  if (["created", "claimed"].includes(job.attempt_status) && hasProviderSubmission) {
    return {
      jobId: job.id,
      classification: "unreconciled",
      status: job.status,
      reason: "unexpected_provider_submission_evidence",
    };
  }
  if (job.attempt_status === "submitting") {
    return job.submitted_at
      ? { jobId: job.id, classification: "provider_acceptance_unknown", status: job.status }
      : { jobId: job.id, classification: "unreconciled", status: job.status, reason: "missing_submission_timestamp" };
  }
  if (job.attempt_status === "accepted" && (!job.provider_task_id || !job.submitted_at)) {
    return { jobId: job.id, classification: "unreconciled", status: job.status, reason: "missing_provider_acceptance_evidence" };
  }
  if (job.attempt_status === "materializing") {
    const mediaUrls = job.evidence_json?.mediaUrls;
    if (!job.submitted_at || (!job.provider_task_id && (!Array.isArray(mediaUrls) || mediaUrls.length === 0))) {
      return { jobId: job.id, classification: "unreconciled", status: job.status, reason: "missing_materialization_evidence" };
    }
  }
  return {
    jobId: job.id,
    classification: "synthetic_control_plane_probe",
    status: job.status,
    probeStatus: probe.status,
    workflowName: probe.workflow_name,
  };
}

export async function reconcileRestoredJobs({ businessUrl, hatchetUrl }) {
  const business = postgres(businessUrl, { max: 1, prepare: false });
  const hatchet = postgres(hatchetUrl, { max: 1, prepare: false });
  try {
    const jobs = await business`
      select job.id::text, job.status::text, attempt.status::text as attempt_status,
             attempt.executor_run_id, attempt.provider_task_id, attempt.submitted_at, attempt.evidence_json
      from generation_jobs job
      join generation_attempts attempt on attempt.id = job.current_attempt_id
      order by job.id
    `;
    const probes = await hatchet`select run_id, status, workflow_name from recovery_drill_probe_runs order by run_id`;
    const probeById = new Map(probes.map((probe) => [probe.run_id, probe]));
    const reconciliation = jobs.map((job) => classifyRestoredJob(job, probeById));
    if (reconciliation.some(({ classification }) => classification === "unreconciled")) {
      throw new Error("At least one restored current job could not be reconciled");
    }
    const schema = await hatchet`
      select coalesce(max(version_id), 0)::text as version from goose_db_version where is_applied
    `;
    return { hatchetSchemaVersion: schema[0]?.version ?? "0", jobs: reconciliation };
  } finally {
    await Promise.all([business.end(), hatchet.end()]);
  }
}
