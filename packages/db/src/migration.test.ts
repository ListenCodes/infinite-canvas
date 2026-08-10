import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { bindMigrationOrder, collectMigrationFiles, validateMigrationLedger } from "./migration-runner.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(packageDir, "migrations");

const ids = {
  userA: "00000000-0000-4000-8000-000000000001",
  userB: "00000000-0000-4000-8000-000000000002",
  workspaceA: "00000000-0000-4000-8000-000000000101",
  workspaceB: "00000000-0000-4000-8000-000000000102",
  projectA: "00000000-0000-4000-8000-000000000201",
  projectB: "00000000-0000-4000-8000-000000000202",
  channel: "00000000-0000-4000-8000-000000000301",
  model: "00000000-0000-4000-8000-000000000401",
  request: "00000000-0000-4000-8000-000000000501",
  batch: "00000000-0000-4000-8000-000000000601",
  job: "00000000-0000-4000-8000-000000000701",
  legacyJob: "00000000-0000-4000-8000-000000000702",
  attempt: "00000000-0000-4000-8000-000000000801",
  dispatchToken: "00000000-0000-4000-8000-000000000802",
  recoveryDispatchToken: "00000000-0000-4000-8000-000000000803",
  legacyAttempt: "00000000-0000-4000-8000-000000000804",
  partialCapacityAttempt: "00000000-0000-4000-8000-000000000805",
  outbox: "00000000-0000-4000-8000-000000000901",
  outboxV2: "00000000-0000-4000-8000-000000000902",
  outboxInvalidVersion: "00000000-0000-4000-8000-000000000903",
  outboxFutureVersion: "00000000-0000-4000-8000-000000000904",
  reservation: "00000000-0000-4000-8000-000000001001",
  reserveEntry: "00000000-0000-4000-8000-000000001101",
  settleEntry: "00000000-0000-4000-8000-000000001102",
};

async function applyMigrations(db: PGlite): Promise<void> {
  for (const migration of await collectMigrationFiles(migrationsDir)) {
    await db.exec(await readFile(migration.path, "utf8"));
  }
}

async function applyThrough(db: PGlite, target: string): Promise<void> {
  const migrations = await collectMigrationFiles(migrationsDir);
  const targetIndex = migrations.findIndex(({ name }) => name === target);
  assert.notEqual(targetIndex, -1, `Unknown migration target ${target}`);
  for (const migration of migrations.slice(0, targetIndex + 1)) {
    await db.exec(await readFile(migration.path, "utf8"));
  }
}

test("initial migrations enforce tenant, execution, outbox, and wallet invariants", async () => {
  const db = new PGlite();
  try {
    const migrationNames = (await collectMigrationFiles(migrationsDir)).map(({ name }) => name);
    assert.deepEqual(migrationNames, [
      "drizzle/0000_glossy_zeigeist.sql",
      "drizzle/0001_round_malice.sql",
      "drizzle/0002_gifted_killraven.sql",
      "custom/0002_runtime_invariants.sql",
      "drizzle/0003_steady_sunspot.sql",
      "drizzle/0004_public_carlie_cooper.sql",
      "custom/0004_import_links.sql",
      "drizzle/0005_volatile_unus.sql",
      "custom/0005_import_mapping_policy.sql",
      "drizzle/0006_optimal_hannibal_king.sql",
      "custom/0006_integrity_and_batch.sql",
      "drizzle/0007_pale_miek.sql",
      "custom/0007_runtime_role_safety.sql",
      "custom/0009_attempt_recovery_claim.sql",
      "drizzle/0008_swift_the_professor.sql",
      "custom/0010_platform_idempotency.sql",
      "custom/0011_executor_dispatch_fence.sql",
      "drizzle/0009_adorable_captain_midlands.sql",
      "drizzle/0010_clammy_susan_delgado.sql",
      "custom/0012_runtime_acl_hardening.sql",
      "drizzle/0011_volatile_butterfly.sql",
      "drizzle/0012_demonic_captain_flint.sql",
      "custom/0013_capacity_runtime.sql",
      "custom/0014_versioned_outbox_claim.sql",
    ]);
    await applyMigrations(db);

    await db.exec(`
      select set_config('app.service_role', 'on', false);
      insert into profiles (user_id, display_name) values
        ('${ids.userA}', 'A'), ('${ids.userB}', 'B');
      insert into workspaces (id, owner_user_id, name) values
        ('${ids.workspaceA}', '${ids.userA}', 'Workspace A'),
        ('${ids.workspaceB}', '${ids.userB}', 'Workspace B');
      insert into workspace_members (workspace_id, user_id, role) values
        ('${ids.workspaceA}', '${ids.userA}', 'owner'),
        ('${ids.workspaceB}', '${ids.userB}', 'owner');
      insert into projects (id, workspace_id, title, document_json, updated_by) values
        ('${ids.projectA}', '${ids.workspaceA}', 'Project A', '{}', '${ids.userA}'),
        ('${ids.projectB}', '${ids.workspaceB}', 'Project B', '{}', '${ids.userB}');
      insert into provider_channels (id, name, type, base_url, capabilities)
        values ('${ids.channel}', 'test', 'mock', 'https://provider.example', '["image"]');
      insert into model_configs (
        id, channel_id, model, capability, adapter_type, adapter_version,
        config_version, limits_json, concurrency_limit
      ) values (
        '${ids.model}', '${ids.channel}', 'test-image', 'image', 'mock', 1, 1, '{}', 3
      );
      insert into provider_channel_capacity_policies (
        channel_id, capability, version, concurrency_limit, rate_limit_per_minute
      ) values ('${ids.channel}', 'image', 1, 3, 60);
      insert into idempotency_requests (
        id, workspace_id, operation, key, request_hash, expires_at
      ) values (
        '${ids.request}', '${ids.workspaceA}', 'batch.create', 'key-1', 'sha256', now() + interval '1 day'
      );
      insert into generation_batches (
        id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by
      ) values (
        '${ids.batch}', '${ids.workspaceA}', '${ids.projectA}', 'image', 1, '${ids.request}', '${ids.userA}'
      );
      insert into generation_jobs (
        id, workspace_id, batch_id, slot_index, capability, model_config_id,
        model_snapshot, price_snapshot, input_snapshot, estimated_credits
      ) values (
        '${ids.job}', '${ids.workspaceA}', '${ids.batch}', 0, 'image', '${ids.model}', '{}', '{}', '{}', 10
      );
      insert into generation_attempts (
        id, workspace_id, job_id, attempt_no, channel_id, credential_version,
        adapter_type, adapter_version, request_fingerprint, business_deadline_at, executor_dispatch_token,
        capacity_policy_version, workspace_concurrency_limit, workspace_rate_limit_per_minute,
        channel_concurrency_limit, channel_rate_limit_per_minute
      ) values (
        '${ids.attempt}', '${ids.workspaceA}', '${ids.job}', 1, '${ids.channel}', 1,
        'mock', 1, 'fingerprint', now() + interval '5 minutes', '${ids.dispatchToken}',
        1, 3, 30, 3, 60
      );
      update generation_jobs set current_attempt_id = '${ids.attempt}' where id = '${ids.job}';
      insert into wallet_accounts (workspace_id, available) values ('${ids.workspaceA}', 100);
      insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
        values
          ('${ids.outbox}', '${ids.workspaceA}', 'generation.job.requested', '${ids.job}', 'attempt:${ids.attempt}', '{"schemaVersion":1}'),
          ('${ids.outboxV2}', '${ids.workspaceA}', 'generation.job.requested', '${ids.job}', 'attempt-v2:${ids.attempt}', '{"schemaVersion":2}'),
          ('${ids.outboxInvalidVersion}', '${ids.workspaceA}', 'generation.job.requested', '${ids.job}', 'attempt-invalid:${ids.attempt}', '{"schemaVersion":0}'),
          ('${ids.outboxFutureVersion}', '${ids.workspaceA}', 'generation.job.requested', '${ids.job}', 'attempt-future:${ids.attempt}', '{"schemaVersion":3}');
    `);

    await assert.rejects(
      db.exec(`insert into generation_job_targets (job_id, workspace_id, project_id, node_id, slot_id)
        values ('${ids.job}', '${ids.workspaceB}', '${ids.projectB}', 'node', 'slot')`),
      /foreign key|violates/i,
    );

    const forgedClaim = await db.query<{ result: string }>(
      `select app.claim_generation_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9) as result`,
      [ids.workspaceA, ids.projectB, ids.batch, ids.job, ids.attempt, ids.channel, "image", ids.dispatchToken, "forged-worker"],
    );
    assert.equal(forgedClaim.rows[0]?.result, "terminal");
    const unclaimed = await db.query<{ executor_claim_id: string | null }>(
      `select executor_claim_id from generation_attempts where id = $1`,
      [ids.attempt],
    );
    assert.equal(unclaimed.rows[0]?.executor_claim_id, null);

    const claim = await db.query<{ result: string }>(
      `select app.claim_generation_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9) as result`,
      [ids.workspaceA, ids.projectA, ids.batch, ids.job, ids.attempt, ids.channel, "image", ids.dispatchToken, "worker-1"],
    );
    assert.equal(claim.rows[0]?.result, "claimed");
    const resumed = await db.query<{ result: string }>(
      `select app.claim_generation_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9) as result`,
      [ids.workspaceA, ids.projectA, ids.batch, ids.job, ids.attempt, ids.channel, "image", ids.dispatchToken, "worker-1"],
    );
    assert.equal(resumed.rows[0]?.result, "claimed");
    const duplicate = await db.query<{ result: string }>(
      `select app.claim_generation_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9) as result`,
      [ids.workspaceA, ids.projectA, ids.batch, ids.job, ids.attempt, ids.channel, "image", ids.dispatchToken, "worker-2"],
    );
    assert.equal(duplicate.rows[0]?.result, "duplicate");
    await db.query(
      `update generation_attempts set status = 'materializing', executor_claim_id = null,
         executor_dispatch_token = $2 where id = $1`,
      [ids.attempt, ids.recoveryDispatchToken],
    );
    const staleRecovery = await db.query<{ result: string }>(
      `select app.claim_generation_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9) as result`,
      [ids.workspaceA, ids.projectA, ids.batch, ids.job, ids.attempt, ids.channel, "image", ids.dispatchToken, "worker-stale"],
    );
    assert.equal(staleRecovery.rows[0]?.result, "duplicate");
    const recovered = await db.query<{ result: string }>(
      `select app.claim_generation_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9) as result`,
      [ids.workspaceA, ids.projectA, ids.batch, ids.job, ids.attempt, ids.channel, "image", ids.recoveryDispatchToken, "worker-recovery"],
    );
    assert.equal(recovered.rows[0]?.result, "claimed");

    const outbox = await db.query<{ id: string; attempts: number }>(
      `select id, attempts from app.claim_outbox($1, $2)`,
      ["dispatcher-1", 10],
    );
    assert.deepEqual(outbox.rows, [{ id: ids.outbox, attempts: 1 }]);
    const secondOutboxClaim = await db.query(`select id from app.claim_outbox($1, $2)`, ["dispatcher-2", 10]);
    assert.equal(secondOutboxClaim.rows.length, 0);
    const v2Outbox = await db.query<{ id: string; attempts: number }>(
      `select id, attempts from app.claim_outbox($1, $2, $3)`,
      ["dispatcher-v2", 2, 10],
    );
    assert.deepEqual(
      v2Outbox.rows.sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: ids.outboxV2, attempts: 1 },
        { id: ids.outboxInvalidVersion, attempts: 1 },
      ],
    );
    const futureVersion = await db.query<{ status: string; attempts: number }>(
      `select status, attempts from outbox_events where id = $1`,
      [ids.outboxFutureVersion],
    );
    assert.deepEqual(futureVersion.rows, [{ status: "pending", attempts: 0 }]);

    await db.query(`select app.reserve_credits($1, $2, $3, $4, $5, $6, now() + interval '1 hour')`, [
      ids.reservation,
      ids.reserveEntry,
      ids.workspaceA,
      ids.job,
      ids.attempt,
      10,
    ]);
    await db.query(`select app.reserve_credits($1, $2, $3, $4, $5, $6, now() + interval '1 hour')`, [
      ids.reservation,
      ids.reserveEntry,
      ids.workspaceA,
      ids.job,
      ids.attempt,
      10,
    ]);
    let wallet = await db.query<{ available: string; reserved: string }>(
      `select available::text, reserved::text from wallet_accounts where workspace_id = $1`,
      [ids.workspaceA],
    );
    assert.deepEqual(wallet.rows[0], { available: "90", reserved: "10" });
    await db.query(`select app.settle_reservation($1, $2)`, [ids.attempt, ids.settleEntry]);
    wallet = await db.query<{ available: string; reserved: string }>(
      `select available::text, reserved::text from wallet_accounts where workspace_id = $1`,
      [ids.workspaceA],
    );
    assert.deepEqual(wallet.rows[0], { available: "90", reserved: "0" });
    const entries = await db.query<{ kind: string }>(
      `select kind from wallet_entries where workspace_id = $1 order by created_at, kind`,
      [ids.workspaceA],
    );
    assert.deepEqual(entries.rows.map(({ kind }) => kind).sort(), ["reserve", "settle"]);
    await assert.rejects(
      db.query(`update wallet_entries set reason = 'tampered' where id = $1`, [ids.reserveEntry]),
      /append-only/i,
    );

    await db.exec(`
      create role infinite_canvas_test;
      grant usage on schema public, app to infinite_canvas_test;
      grant execute on function app.current_user_id(), app.is_service_role(), app.is_platform_admin(), app.has_workspace_access(uuid, workspace_role[])
        to infinite_canvas_test;
      grant select on profiles, workspaces, workspace_members, projects to infinite_canvas_test;
      set role infinite_canvas_test;
      select set_config('app.user_id', '${ids.userA}', false);
      select set_config('app.service_role', 'off', false);
    `);
    const visible = await db.query<{ id: string }>(`select id from projects order by id`);
    assert.deepEqual(visible.rows, [{ id: ids.projectA }]);
    await db.exec(`reset role`);

    await db.exec(`
      select set_config('app.service_role', 'on', false);
      update generation_attempts
      set status = 'outcome_unknown', outcome_unknown_at = now(),
          reconcile_after = now() + interval '1 hour', release_after = now() + interval '24 hours'
      where id = '${ids.attempt}';
    `);
    await assert.rejects(
      db.exec(`
        update generation_attempts
        set outcome_unknown_at = outcome_unknown_at + interval '1 minute',
            release_after = release_after + interval '1 minute'
        where id = '${ids.attempt}'
      `),
      /immutable/i,
    );
    await assert.rejects(
      db.exec(`update generation_attempts set channel_concurrency_limit = 4 where id = '${ids.attempt}'`),
      /capacity snapshot is immutable/i,
    );
    await assert.rejects(
      db.exec(`
        update provider_channel_capacity_policies set concurrency_limit = 4
        where channel_id = '${ids.channel}' and capability = 'image' and version = 1
      `),
      /append-only/i,
    );
    await assert.rejects(
      db.exec(`
        insert into provider_channel_capacity_leases (channel_id, capability, holder_id, lease_expires_at)
        values ('${ids.channel}', 'video', '${ids.attempt}', now() + interval '5 minutes')
      `),
      /invalid provider channel capacity lease/i,
    );
    await assert.rejects(
      db.exec(`
        insert into generation_capacity_rate_windows (workspace_id, channel_id, capability, window_started_at, used)
        values ('${ids.workspaceA}', '${ids.channel}', 'image', date_trunc('minute', now()), 1)
      `),
      /generation_capacity_rate_windows_scope|check constraint/i,
    );
    await assert.rejects(
      db.exec(`
        insert into generation_capacity_rate_windows (workspace_id, channel_id, capability, window_started_at, used)
        values ('${ids.workspaceA}', null, 'image', date_trunc('minute', now()) + interval '1 second', 1)
      `),
      /generation_capacity_rate_windows_minute_aligned|check constraint/i,
    );
    await db.exec(`
      insert into generation_capacity_rate_windows (workspace_id, channel_id, capability, window_started_at, used)
      values ('${ids.workspaceA}', null, 'image', date_trunc('minute', now()), 1)
      on conflict (workspace_id, capability, window_started_at)
        where workspace_id is not null and channel_id is null
      do update set used = generation_capacity_rate_windows.used + 1, updated_at = now();
      insert into generation_capacity_rate_windows (workspace_id, channel_id, capability, window_started_at, used)
      values ('${ids.workspaceA}', null, 'image', date_trunc('minute', now()), 1)
      on conflict (workspace_id, capability, window_started_at)
        where workspace_id is not null and channel_id is null
      do update set used = generation_capacity_rate_windows.used + 1, updated_at = now();
    `);
    const rateUsage = await db.query<{ used: number }>(`
      select used from generation_capacity_rate_windows
      where workspace_id = '${ids.workspaceA}' and capability = 'image'
    `);
    assert.equal(rateUsage.rows[0]?.used, 2);
    await db.exec(`
      insert into provider_channel_capacity_leases (channel_id, capability, holder_id, lease_expires_at)
      values ('${ids.channel}', 'image', '${ids.attempt}', now() + interval '5 minutes');
      update generation_attempts set status = 'failed', completed_at = now() where id = '${ids.attempt}';
    `);
    const releasedCapacity = await db.query<{ count: number }>(
      `select count(*)::int as count from provider_channel_capacity_leases where holder_id = $1`,
      [ids.attempt],
    );
    assert.equal(releasedCapacity.rows[0]?.count, 0);

    const down = await readFile(resolve(migrationsDir, "down", "0001_initial.sql"), "utf8");
    await db.exec(down);
    const remaining = await db.query<{ name: string }>(
      `select table_name as name from information_schema.tables where table_schema = 'public' and table_name = 'generation_jobs'`,
    );
    assert.equal(remaining.rows.length, 0);
  } finally {
    await db.close();
  }
});

test("an untrusted login cannot forge service role through SECURITY DEFINER helpers", async () => {
  const db = new PGlite();
  try {
    await applyMigrations(db);
    await db.exec(`
      select set_config('app.service_role', 'on', false);
      insert into profiles (user_id, display_name) values ('${ids.userA}', 'A');
      insert into workspaces (id, owner_user_id, name) values ('${ids.workspaceA}', '${ids.userA}', 'Workspace A');
      insert into workspace_members (workspace_id, user_id, role) values ('${ids.workspaceA}', '${ids.userA}', 'owner');
      insert into projects (id, workspace_id, title, document_json, updated_by)
        values ('${ids.projectA}', '${ids.workspaceA}', 'Project A', '{}', '${ids.userA}');
      create role infinite_canvas_attacker;
      grant usage on schema app, public to infinite_canvas_attacker;
      grant execute on function app.current_user_id(), app.is_service_role(), app.is_platform_admin(), app.has_workspace_access(uuid, workspace_role[])
        to infinite_canvas_attacker;
      grant select, update on profiles, workspaces, workspace_members, projects to infinite_canvas_attacker;
      set session authorization infinite_canvas_attacker;
      select set_config('app.user_id', '', false);
      select set_config('app.service_role', 'on', false);
    `);
    const forgedService = await db.query<{ allowed: boolean }>(`select app.has_workspace_access($1) as allowed`, [ids.workspaceA]);
    assert.equal(forgedService.rows[0]?.allowed, false);
    const forgedVisible = await db.query<{ id: string }>(`select id from projects order by id`);
    assert.deepEqual(forgedVisible.rows, []);
    const forgedUpdate = await db.query<{ id: string }>(`update projects set title = 'stolen' where id = $1 returning id`, [ids.projectA]);
    assert.deepEqual(forgedUpdate.rows, []);
  } finally {
    await db.close();
  }
});

test("recovery service members can read through RLS helpers but cannot execute write functions", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role infinite_canvas_service nologin noinherit;
      create role infinite_canvas_recovery_test noinherit;
      grant infinite_canvas_service to infinite_canvas_recovery_test;
    `);
    await applyMigrations(db);
    await db.exec(`
      grant usage on schema public, app to infinite_canvas_recovery_test;
      set session authorization infinite_canvas_recovery_test;
    `);
    const privileges = await db.query<{
      helper: boolean;
      claim_outbox: boolean;
      claim_outbox_v2: boolean;
      reserve: boolean;
      release: boolean;
      refresh_batch: boolean;
    }>(`
      select
        has_function_privilege(current_user, 'app.is_service_role()', 'EXECUTE') as helper,
        has_function_privilege(current_user, 'app.claim_outbox(text,integer)', 'EXECUTE') as claim_outbox,
        has_function_privilege(current_user, 'app.claim_outbox(text,integer,integer)', 'EXECUTE') as claim_outbox_v2,
        has_function_privilege(current_user, 'app.reserve_credits(uuid,uuid,uuid,uuid,uuid,bigint,timestamptz)', 'EXECUTE') as reserve,
        has_function_privilege(current_user, 'app.release_reservation(uuid,uuid,text)', 'EXECUTE') as release,
        has_function_privilege(current_user, 'app.refresh_generation_batch(uuid)', 'EXECUTE') as refresh_batch
    `);
    assert.deepEqual(privileges.rows[0], {
      helper: true,
      claim_outbox: false,
      claim_outbox_v2: false,
      reserve: false,
      release: false,
      refresh_batch: false,
    });
    await assert.rejects(
      db.query(`select app.refresh_generation_batch($1)`, [ids.batch]),
      /permission denied/i,
    );
  } finally {
    await db.close();
  }
});

test("migration order rejects generated SQL that was not explicitly appended", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "infinite-canvas-migrations-"));
  try {
    const drizzle = resolve(directory, "drizzle");
    await mkdir(drizzle, { recursive: true });
    await writeFile(resolve(drizzle, "0000_initial.sql"), "select 1;\n");
    await writeFile(resolve(drizzle, "0001_unlisted.sql"), "select 2;\n");
    await writeFile(resolve(directory, "order.txt"), "drizzle/0000_initial.sql\n");
    await assert.rejects(
      collectMigrationFiles(directory),
      /unlisted=\[drizzle\/0001_unlisted\.sql\]/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration ledger rejects checksum drift, unknown rows, holes, and manifest reorder", () => {
  const prepared = bindMigrationOrder([
    { name: "0001.sql", checksum: "a".repeat(64) },
    { name: "0002.sql", checksum: "b".repeat(64) },
    { name: "0003.sql", checksum: "c".repeat(64) },
  ]);
  const applied = prepared.map((migration) => ({
    name: migration.name,
    sha256: migration.checksum,
    manifest_position: migration.position,
    prefix_hash: migration.prefixHash,
  }));
  validateMigrationLedger(prepared, applied);
  assert.throws(
    () => validateMigrationLedger(prepared, [{ ...applied[0]!, sha256: "f".repeat(64) }]),
    /Applied migration changed/,
  );
  assert.throws(
    () => validateMigrationLedger(prepared, [...applied, { name: "unknown.sql", sha256: "d".repeat(64), manifest_position: 3, prefix_hash: "e".repeat(64) }]),
    /unknown migrations/,
  );
  assert.throws(
    () => validateMigrationLedger(prepared, [applied[0]!, applied[2]!]),
    /not a prefix/,
  );
  const reordered = bindMigrationOrder([
    { name: "0002.sql", checksum: "b".repeat(64) },
    { name: "0001.sql", checksum: "a".repeat(64) },
    { name: "0003.sql", checksum: "c".repeat(64) },
  ]);
  assert.throws(
    () => validateMigrationLedger(reordered, applied),
    /order changed|prefix changed/,
  );
});

test("capacity migrations backfill an existing release prefix and restore FORCE RLS", async () => {
  const db = new PGlite();
  try {
    await applyThrough(db, "custom/0012_runtime_acl_hardening.sql");
    await db.exec(`
      select set_config('app.service_role', 'on', false);
      insert into profiles (user_id, display_name) values ('${ids.userA}', 'A');
      insert into workspaces (id, owner_user_id, name) values ('${ids.workspaceA}', '${ids.userA}', 'A');
      insert into workspace_members (workspace_id, user_id, role) values ('${ids.workspaceA}', '${ids.userA}', 'owner');
      insert into projects (id, workspace_id, title, document_json, updated_by)
        values ('${ids.projectA}', '${ids.workspaceA}', 'A', '{}', '${ids.userA}');
      insert into provider_channels (id, name, type, base_url, capabilities)
        values ('${ids.channel}', 'legacy', 'mock', 'https://provider.example', '["image"]');
      insert into model_configs (
        id, channel_id, model, capability, adapter_type, adapter_version,
        config_version, limits_json, concurrency_limit
      ) values ('${ids.model}', '${ids.channel}', 'legacy-image', 'image', 'mock', 1, 1, '{}', 4);
      insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values ('${ids.request}', '${ids.workspaceA}', 'batch.create', 'capacity-prefix', 'hash', now() + interval '1 day');
      insert into generation_batches (id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by)
        values ('${ids.batch}', '${ids.workspaceA}', '${ids.projectA}', 'image', 1, '${ids.request}', '${ids.userA}');
      insert into generation_jobs (
        id, workspace_id, batch_id, slot_index, capability, model_config_id,
        model_snapshot, price_snapshot, input_snapshot, estimated_credits
      ) values ('${ids.job}', '${ids.workspaceA}', '${ids.batch}', 0, 'image', '${ids.model}', '{}', '{}', '{}', 1);
      insert into generation_attempts (
        id, workspace_id, job_id, attempt_no, channel_id, credential_version,
        adapter_type, adapter_version, request_fingerprint, business_deadline_at,
        executor_dispatch_token
      ) values (
        '${ids.attempt}', '${ids.workspaceA}', '${ids.job}', 1, '${ids.channel}', 1,
        'mock', 1, 'legacy-fingerprint', now() + interval '30 minutes', '${ids.dispatchToken}'
      );
      update generation_jobs set current_attempt_id = '${ids.attempt}' where id = '${ids.job}';
      insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
      values (
        '${ids.outbox}', '${ids.workspaceA}', 'generation.job.requested', '${ids.job}',
        'legacy-capacity-outbox', jsonb_build_object(
          'schemaVersion', 1, 'workflowName', 'media-generation-v1',
          'workspaceId', '${ids.workspaceA}', 'projectId', '${ids.projectA}',
          'batchId', '${ids.batch}', 'jobId', '${ids.job}', 'attemptId', '${ids.attempt}',
          'capability', 'image', 'channelId', '${ids.channel}'
        )
      );
    `);
    await db.exec(`select set_config('app.service_role', 'off', false)`);
    const migrations = await collectMigrationFiles(migrationsDir);
    const prefixIndex = migrations.findIndex(({ name }) => name === "custom/0012_runtime_acl_hardening.sql");
    assert.notEqual(prefixIndex, -1);
    for (const migration of migrations.slice(prefixIndex + 1)) {
      await db.exec(await readFile(migration.path, "utf8"));
    }
    await db.exec(`select set_config('app.service_role', 'on', false)`);
    const policy = await db.query<{
      version: number; concurrency_limit: number; rate_limit_per_minute: number;
    }>(`
      select version, concurrency_limit, rate_limit_per_minute
      from provider_channel_capacity_policies
      where channel_id = '${ids.channel}' and capability = 'image'
    `);
    assert.deepEqual(policy.rows, [{ version: 1, concurrency_limit: 4, rate_limit_per_minute: 60 }]);
    await db.exec(`
      insert into generation_jobs (
        id, workspace_id, batch_id, slot_index, capability, model_config_id,
        model_snapshot, price_snapshot, input_snapshot, estimated_credits
      ) values (
        '${ids.legacyJob}', '${ids.workspaceA}', '${ids.batch}', 1, 'image', '${ids.model}',
        '{}', '{}', '{}', 1
      );
      insert into generation_attempts (
        id, workspace_id, job_id, attempt_no, channel_id, credential_version,
        adapter_type, adapter_version, request_fingerprint, business_deadline_at,
        executor_dispatch_token
      ) values (
        '${ids.legacyAttempt}', '${ids.workspaceA}', '${ids.legacyJob}', 1, '${ids.channel}', 1,
        'mock', 1, 'legacy-writer-after-expand', now() + interval '30 minutes', '${ids.recoveryDispatchToken}'
      );
    `);
    const legacyWriterSnapshot = await db.query<{
      capacity_policy_version: number;
      workspace_concurrency_limit: number;
      workspace_rate_limit_per_minute: number;
      channel_concurrency_limit: number;
      channel_rate_limit_per_minute: number;
    }>(`
      select capacity_policy_version, workspace_concurrency_limit,
             workspace_rate_limit_per_minute, channel_concurrency_limit,
             channel_rate_limit_per_minute
      from generation_attempts where id = '${ids.legacyAttempt}'
    `);
    assert.deepEqual(legacyWriterSnapshot.rows[0], {
      capacity_policy_version: 1,
      workspace_concurrency_limit: 3,
      workspace_rate_limit_per_minute: 30,
      channel_concurrency_limit: 4,
      channel_rate_limit_per_minute: 60,
    });
    await assert.rejects(
      db.exec(`
        insert into generation_attempts (
          id, workspace_id, job_id, attempt_no, channel_id, credential_version,
          adapter_type, adapter_version, request_fingerprint, business_deadline_at,
          executor_dispatch_token, capacity_policy_version
        ) values (
          '${ids.partialCapacityAttempt}', '${ids.workspaceA}', '${ids.legacyJob}', 2, '${ids.channel}', 1,
          'mock', 1, 'partial-capacity', now() + interval '30 minutes', '${ids.dispatchToken}', 1
        )
      `),
      /capacity snapshot must be complete/i,
    );
    const snapshot = await db.query<{
      capacity_policy_version: number;
      workspace_concurrency_limit: number;
      workspace_rate_limit_per_minute: number;
      channel_concurrency_limit: number;
      channel_rate_limit_per_minute: number;
      payload_capacity: Record<string, number>;
    }>(`
      select attempt.capacity_policy_version, attempt.workspace_concurrency_limit,
             attempt.workspace_rate_limit_per_minute, attempt.channel_concurrency_limit,
             attempt.channel_rate_limit_per_minute, event.payload->'capacity' as payload_capacity
      from generation_attempts attempt
      join outbox_events event on event.payload->>'attemptId' = attempt.id::text
      where attempt.id = '${ids.attempt}'
    `);
    assert.deepEqual(snapshot.rows[0], {
      capacity_policy_version: 1,
      workspace_concurrency_limit: 3,
      workspace_rate_limit_per_minute: 30,
      channel_concurrency_limit: 4,
      channel_rate_limit_per_minute: 60,
      payload_capacity: {
        policyVersion: 1,
        workspaceConcurrencyLimit: 3,
        workspaceRateLimitPerMinute: 30,
        channelConcurrencyLimit: 4,
        channelRateLimitPerMinute: 60,
      },
    });
    const forced = await db.query<{ count: number }>(`
      select count(*)::int as count from pg_class
      where relname in ('model_configs', 'generation_jobs', 'generation_attempts', 'outbox_events')
        and relforcerowsecurity
    `);
    assert.equal(forced.rows[0]?.count, 4);
  } finally {
    await db.close();
  }
});

test("schema evolution backfills legacy jobs and reclaims legacy verifying assets", async () => {
  const jobs = new PGlite();
  try {
    await applyThrough(jobs, "drizzle/0001_round_malice.sql");
    await jobs.exec(`
      insert into profiles (user_id, display_name) values ('${ids.userA}', 'A');
      insert into workspaces (id, owner_user_id, name) values ('${ids.workspaceA}', '${ids.userA}', 'A');
      insert into workspace_members (workspace_id, user_id, role) values ('${ids.workspaceA}', '${ids.userA}', 'owner');
      insert into projects (id, workspace_id, title, document_json, updated_by)
        values ('${ids.projectA}', '${ids.workspaceA}', 'A', '{}', '${ids.userA}');
      insert into provider_channels (id, name, type, base_url, capabilities)
        values ('${ids.channel}', 'test', 'mock', 'https://provider.example', '["image"]');
      insert into model_configs (
        id, channel_id, model, capability, adapter_type, adapter_version,
        config_version, limits_json, concurrency_limit
      ) values ('${ids.model}', '${ids.channel}', 'model', 'image', 'mock', 1, 1, '{}', 1);
      insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values ('${ids.request}', '${ids.workspaceA}', 'batch.create', 'legacy-key', 'hash', now() + interval '1 day');
      insert into generation_batches (id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by)
        values ('${ids.batch}', '${ids.workspaceA}', '${ids.projectA}', 'image', 1, '${ids.request}', '${ids.userA}');
      insert into generation_jobs (
        id, workspace_id, batch_id, slot_index, capability, model_config_id,
        model_snapshot, price_snapshot, estimated_credits
      ) values ('${ids.job}', '${ids.workspaceA}', '${ids.batch}', 0, 'image', '${ids.model}', '{}', '{}', 1);
    `);
    const migration = (await collectMigrationFiles(migrationsDir)).find(
      ({ name }) => name === "drizzle/0002_gifted_killraven.sql",
    );
    assert.ok(migration);
    await jobs.exec(await readFile(migration.path, "utf8"));
    const snapshots = await jobs.query<{ input_snapshot: Record<string, unknown> }>(
      `select input_snapshot from generation_jobs where id = $1`,
      [ids.job],
    );
    assert.deepEqual(snapshots.rows[0]?.input_snapshot, {});
  } finally {
    await jobs.close();
  }

  const assets = new PGlite();
  try {
    await applyThrough(assets, "custom/0005_import_mapping_policy.sql");
    await assets.exec(`
      select set_config('app.service_role', 'on', false);
      insert into profiles (user_id, display_name) values ('${ids.userA}', 'A');
      insert into workspaces (id, owner_user_id, name) values ('${ids.workspaceA}', '${ids.userA}', 'A');
      insert into workspace_members (workspace_id, user_id, role) values ('${ids.workspaceA}', '${ids.userA}', 'owner');
      insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values ('${ids.attempt}', '${ids.workspaceA}', 'image', 'verifying', 'legacy/object.png', 'image/png', 8, '${"a".repeat(64)}');
    `);
    const migration = (await collectMigrationFiles(migrationsDir)).find(
      ({ name }) => name === "drizzle/0006_optimal_hannibal_king.sql",
    );
    assert.ok(migration);
    await assets.exec(await readFile(migration.path, "utf8"));
    const rows = await assets.query<{ status: string; verification_token: string | null }>(
      `select status, verification_token from assets where id = $1`,
      [ids.attempt],
    );
    assert.deepEqual(rows.rows[0], {
      status: "uploading",
      verification_token: null,
    });
    await assert.rejects(
      assets.query(`update assets set status = 'verifying' where id = $1`, [ids.attempt]),
      /verification_token_status_check|check constraint/i,
    );
  } finally {
    await assets.close();
  }
});

test("integrity migration rejects legacy target rows bound to the wrong batch project", async () => {
  const db = new PGlite();
  try {
    await applyThrough(db, "drizzle/0006_optimal_hannibal_king.sql");
    await db.exec(`
      select set_config('app.service_role', 'on', false);
      insert into profiles (user_id, display_name) values ('${ids.userA}', 'A');
      insert into workspaces (id, owner_user_id, name) values ('${ids.workspaceA}', '${ids.userA}', 'A');
      insert into workspace_members (workspace_id, user_id, role) values ('${ids.workspaceA}', '${ids.userA}', 'owner');
      insert into projects (id, workspace_id, title, document_json, updated_by) values
        ('${ids.projectA}', '${ids.workspaceA}', 'A', '{}', '${ids.userA}'),
        ('${ids.projectB}', '${ids.workspaceA}', 'B', '{}', '${ids.userA}');
      insert into provider_channels (id, name, type, base_url, capabilities)
        values ('${ids.channel}', 'test', 'mock', 'https://provider.example', '["image"]');
      insert into model_configs (
        id, channel_id, model, capability, adapter_type, adapter_version,
        config_version, limits_json, concurrency_limit
      ) values ('${ids.model}', '${ids.channel}', 'model', 'image', 'mock', 1, 1, '{}', 1);
      insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values ('${ids.request}', '${ids.workspaceA}', 'batch.create', 'legacy-key', 'hash', now() + interval '1 day');
      insert into generation_batches (id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by)
        values ('${ids.batch}', '${ids.workspaceA}', '${ids.projectA}', 'image', 1, '${ids.request}', '${ids.userA}');
      insert into generation_jobs (
        id, workspace_id, batch_id, slot_index, capability, model_config_id,
        model_snapshot, price_snapshot, input_snapshot, estimated_credits
      ) values ('${ids.job}', '${ids.workspaceA}', '${ids.batch}', 0, 'image', '${ids.model}', '{}', '{}', '{}', 1);
      insert into generation_job_targets (job_id, workspace_id, project_id, node_id, slot_id)
        values ('${ids.job}', '${ids.workspaceA}', '${ids.projectB}', 'node', 'slot');
    `);
    const migration = (await collectMigrationFiles(migrationsDir)).find(
      ({ name }) => name === "custom/0006_integrity_and_batch.sql",
    );
    assert.ok(migration);
    await assert.rejects(
      db.exec(await readFile(migration.path, "utf8")),
      /target project ownership/i,
    );
  } finally {
    await db.close();
  }
});
