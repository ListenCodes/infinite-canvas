import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import postgres from "postgres";

import { assertRuntimeDatabaseRole } from "./runtime-role.js";
import { migrateDatabase } from "./migration-runner.js";
import { provisionRuntimeRoles } from "./provision-runtime-roles.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
const migrationUrl = process.env.TEST_POSTGRES_MIGRATION_URL;
const migrationRole = process.env.TEST_POSTGRES_MIGRATION_ROLE;
const passwordApi = "integration-api-password-12345";
const passwordWorker = "integration-worker-password-67890";
const passwordRecovery = "integration-recovery-password-13579";

function roleUrl(input: string, role: string, password: string): string {
  const parsed = new URL(input);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

test("real PostgreSQL enforces migrations, runtime roles, RLS, and LISTEN/NOTIFY", { skip: !adminUrl || !migrationUrl || !migrationRole }, async () => {
  assert.ok(adminUrl);
  assert.ok(migrationUrl);
  assert.ok(migrationRole);
  const first = await migrateDatabase(migrationUrl, {
    through: "custom/0007_runtime_role_safety.sql",
  });
  assert.ok(first.length > 0);

  await provisionRuntimeRoles({
    BUSINESS_DATABASE_PROVISION_URL: adminUrl,
    BUSINESS_DATABASE_OBJECT_OWNER_ROLE: migrationRole,
    BUSINESS_DATABASE_API_ROLE: "infinite_canvas_api_test",
    BUSINESS_DATABASE_API_PASSWORD: passwordApi,
    BUSINESS_DATABASE_WORKER_ROLE: "infinite_canvas_worker_test",
    BUSINESS_DATABASE_WORKER_PASSWORD: passwordWorker,
    BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE: "infinite_canvas_recovery_test",
    BUSINESS_DATABASE_RECOVERY_AUDIT_PASSWORD: passwordRecovery,
  });
  const postProvisionMigrations = await migrateDatabase(migrationUrl, {
    through: "custom/0012_runtime_acl_hardening.sql",
  });
  assert.deepEqual(postProvisionMigrations, [
    "custom/0009_attempt_recovery_claim.sql",
    "drizzle/0008_swift_the_professor.sql",
    "custom/0010_platform_idempotency.sql",
    "custom/0011_executor_dispatch_fence.sql",
    "drizzle/0009_adorable_captain_midlands.sql",
    "drizzle/0010_clammy_susan_delgado.sql",
    "custom/0012_runtime_acl_hardening.sql",
  ]);
  const legacyUserId = randomUUID();
  const legacyWorkspaceId = randomUUID();
  const legacyProjectId = randomUUID();
  const legacyChannelId = randomUUID();
  const legacyModelId = randomUUID();
  const legacyRequestId = randomUUID();
  const legacyBatchId = randomUUID();
  const legacyJobId = randomUUID();
  const legacyAttemptId = randomUUID();
  const legacyOutboxId = randomUUID();
  const legacyDispatchToken = randomUUID();
  const stagingAdmin = postgres(adminUrl, { max: 1, prepare: false });
  try {
    await stagingAdmin.begin(async (transaction) => {
      await transaction`insert into profiles (user_id, display_name) values (${legacyUserId}, 'Legacy Capacity User')`;
      await transaction`insert into workspaces (id, owner_user_id, name) values (${legacyWorkspaceId}, ${legacyUserId}, 'Legacy Capacity Workspace')`;
      await transaction`insert into workspace_members (workspace_id, user_id, role) values (${legacyWorkspaceId}, ${legacyUserId}, 'owner')`;
      await transaction`insert into projects (id, workspace_id, title, document_json, updated_by) values (${legacyProjectId}, ${legacyWorkspaceId}, 'Legacy Capacity Project', '{}'::jsonb, ${legacyUserId})`;
      await transaction`insert into provider_channels (id, name, type, base_url, capabilities) values (${legacyChannelId}, 'Legacy Capacity Provider', 'openai', 'https://provider.example', '["image"]'::jsonb)`;
      await transaction`
        insert into model_configs (
          id, channel_id, model, capability, adapter_type, adapter_version,
          config_version, limits_json, concurrency_limit
        ) values (${legacyModelId}, ${legacyChannelId}, 'legacy-capacity-image', 'image', 'openai', 1, 1, '{}'::jsonb, 4)
      `;
      await transaction`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values (${legacyRequestId}, ${legacyWorkspaceId}, 'batch.create', 'legacy-capacity-prefix', 'legacy-capacity-hash', now() + interval '1 day')
      `;
      await transaction`
        insert into generation_batches (id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by)
        values (${legacyBatchId}, ${legacyWorkspaceId}, ${legacyProjectId}, 'image', 1, ${legacyRequestId}, ${legacyUserId})
      `;
      await transaction`
        insert into generation_jobs (
          id, workspace_id, batch_id, slot_index, capability, model_config_id,
          model_snapshot, price_snapshot, input_snapshot, estimated_credits
        ) values (${legacyJobId}, ${legacyWorkspaceId}, ${legacyBatchId}, 0, 'image', ${legacyModelId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1)
      `;
      await transaction`
        insert into generation_attempts (
          id, workspace_id, job_id, attempt_no, channel_id, credential_version,
          adapter_type, adapter_version, request_fingerprint, business_deadline_at,
          executor_dispatch_token
        ) values (${legacyAttemptId}, ${legacyWorkspaceId}, ${legacyJobId}, 1, ${legacyChannelId}, 1, 'openai', 1, 'legacy-capacity-fingerprint', now() + interval '30 minutes', ${legacyDispatchToken})
      `;
      await transaction`update generation_jobs set current_attempt_id = ${legacyAttemptId} where id = ${legacyJobId}`;
      await transaction`
        insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
        values (
          ${legacyOutboxId}, ${legacyWorkspaceId}, 'generation.job.requested', ${legacyJobId},
          'legacy-capacity-prefix-outbox', jsonb_build_object(
            'schemaVersion', 1, 'workflowName', 'media-generation-v1',
            'workspaceId', ${legacyWorkspaceId}::text, 'projectId', ${legacyProjectId}::text,
            'batchId', ${legacyBatchId}::text, 'jobId', ${legacyJobId}::text,
            'attemptId', ${legacyAttemptId}::text, 'capability', 'image',
            'channelId', ${legacyChannelId}::text
          )
        )
      `;
    });
  } finally {
    await stagingAdmin.end();
  }
  const capacityMigrations = await migrateDatabase(migrationUrl);
  assert.deepEqual(capacityMigrations, [
    "drizzle/0011_volatile_butterfly.sql",
    "drizzle/0012_demonic_captain_flint.sql",
    "custom/0013_capacity_runtime.sql",
    "custom/0014_versioned_outbox_claim.sql",
  ]);
  assert.deepEqual(await migrateDatabase(migrationUrl), []);

  const admin = postgres(adminUrl, { max: 3, prepare: false });
  const api = postgres(roleUrl(adminUrl, "infinite_canvas_api_test", passwordApi), { max: 2, prepare: false });
  const recovery = postgres(roleUrl(adminUrl, "infinite_canvas_recovery_test", passwordRecovery), { max: 1, prepare: false });
  const attackerPassword = "integration-attacker-password-24680";
  const userA = "00000000-0000-4000-8000-00000000a001";
  const userB = "00000000-0000-4000-8000-00000000b001";
  const workspaceA = "00000000-0000-4000-8000-00000000a101";
  const workspaceB = "00000000-0000-4000-8000-00000000b101";
  const projectA = "00000000-0000-4000-8000-00000000a201";
  const projectB = "00000000-0000-4000-8000-00000000b201";

  try {
    const legacyCapacity = await admin<{
      policy_version: number;
      workspace_concurrency: number;
      workspace_rate: number;
      channel_concurrency: number;
      channel_rate: number;
      payload_capacity: Record<string, number>;
    }[]>`
      select attempt.capacity_policy_version as policy_version,
             attempt.workspace_concurrency_limit as workspace_concurrency,
             attempt.workspace_rate_limit_per_minute as workspace_rate,
             attempt.channel_concurrency_limit as channel_concurrency,
             attempt.channel_rate_limit_per_minute as channel_rate,
             outbox.payload->'capacity' as payload_capacity
      from generation_attempts attempt
      join outbox_events outbox on outbox.id = ${legacyOutboxId}
      where attempt.id = ${legacyAttemptId}
    `;
    assert.deepEqual(legacyCapacity[0], {
      policy_version: 1,
      workspace_concurrency: 3,
      workspace_rate: 30,
      channel_concurrency: 4,
      channel_rate: 60,
      payload_capacity: {
        policyVersion: 1,
        workspaceConcurrencyLimit: 3,
        workspaceRateLimitPerMinute: 30,
        channelConcurrencyLimit: 4,
        channelRateLimitPerMinute: 60,
      },
    });
    const ownership = await admin<{
      owner: string;
      superuser: boolean;
      bypass_rls: boolean;
      profiles_force: boolean;
      members_force: boolean;
      projects_force: boolean;
      provider_channels_force: boolean;
      policies_force: boolean;
      leases_force: boolean;
      rate_windows_force: boolean;
    }[]>`
      select owner.rolname as owner, owner.rolsuper as superuser,
             owner.rolbypassrls as bypass_rls,
             (select relforcerowsecurity from pg_class where oid = 'profiles'::regclass) as profiles_force,
             (select relforcerowsecurity from pg_class where oid = 'workspace_members'::regclass) as members_force,
             (select relforcerowsecurity from pg_class where oid = 'projects'::regclass) as projects_force,
             (select relforcerowsecurity from pg_class where oid = 'provider_channels'::regclass) as provider_channels_force,
             (select relforcerowsecurity from pg_class where oid = 'provider_channel_capacity_policies'::regclass) as policies_force,
             (select relforcerowsecurity from pg_class where oid = 'provider_channel_capacity_leases'::regclass) as leases_force,
             (select relforcerowsecurity from pg_class where oid = 'generation_capacity_rate_windows'::regclass) as rate_windows_force
      from pg_proc function
      join pg_roles owner on owner.oid = function.proowner
      where function.oid = 'app.has_workspace_access(uuid,workspace_role[])'::regprocedure
    `;
    assert.deepEqual(ownership[0], {
      owner: migrationRole,
      superuser: false,
      bypass_rls: false,
      profiles_force: false,
      members_force: false,
      projects_force: true,
      provider_channels_force: true,
      policies_force: true,
      leases_force: true,
      rate_windows_force: true,
    });
    const claimPrivilege = await admin<{ allowed: boolean }[]>`
      select has_function_privilege(
        'infinite_canvas_worker_test',
        'app.claim_generation_attempt(uuid,uuid,uuid,uuid,uuid,uuid,generation_capability,uuid,text)',
        'EXECUTE'
      ) as allowed
    `;
    assert.equal(claimPrivilege[0]?.allowed, true);
    const recoveryPrivileges = await admin<{
      claim: boolean;
      release: boolean;
      refresh_batch: boolean;
      helper: boolean;
      can_select: boolean;
      can_update: boolean;
      can_select_platform_idempotency: boolean;
      can_update_platform_idempotency: boolean;
      can_select_migrations: boolean;
      can_update_migrations: boolean;
      api_can_update_future_table: boolean;
      worker_can_update_future_table: boolean;
      recovery_can_select_capacity: boolean;
      recovery_can_update_capacity: boolean;
      api_can_update_capacity: boolean;
      worker_can_update_capacity: boolean;
    }[]>`
      select
        has_function_privilege(
          'infinite_canvas_recovery_test',
          'app.claim_generation_attempt(uuid,uuid,uuid,uuid,uuid,uuid,generation_capability,uuid,text)',
          'EXECUTE'
        ) as claim,
        has_function_privilege('infinite_canvas_recovery_test', 'app.release_reservation(uuid,uuid,text)', 'EXECUTE') as release,
        has_function_privilege('infinite_canvas_recovery_test', 'app.refresh_generation_batch(uuid)', 'EXECUTE') as refresh_batch,
        has_function_privilege('infinite_canvas_recovery_test', 'app.is_service_role()', 'EXECUTE') as helper,
        has_table_privilege('infinite_canvas_recovery_test', 'generation_attempts', 'SELECT') as can_select,
        has_table_privilege('infinite_canvas_recovery_test', 'generation_attempts', 'UPDATE') as can_update,
        has_table_privilege('infinite_canvas_recovery_test', 'platform_idempotency_requests', 'SELECT') as can_select_platform_idempotency,
        has_table_privilege('infinite_canvas_recovery_test', 'platform_idempotency_requests', 'UPDATE') as can_update_platform_idempotency,
        has_table_privilege('infinite_canvas_recovery_test', 'app_schema_migrations', 'SELECT') as can_select_migrations,
        has_table_privilege('infinite_canvas_recovery_test', 'app_schema_migrations', 'UPDATE') as can_update_migrations,
        has_table_privilege('infinite_canvas_api_test', 'platform_idempotency_requests', 'UPDATE') as api_can_update_future_table,
        has_table_privilege('infinite_canvas_worker_test', 'platform_idempotency_requests', 'UPDATE') as worker_can_update_future_table,
        has_table_privilege('infinite_canvas_recovery_test', 'provider_channel_capacity_leases', 'SELECT')
          and has_table_privilege('infinite_canvas_recovery_test', 'provider_channel_capacity_policies', 'SELECT')
          and has_table_privilege('infinite_canvas_recovery_test', 'generation_capacity_rate_windows', 'SELECT')
          as recovery_can_select_capacity,
        has_table_privilege('infinite_canvas_recovery_test', 'provider_channel_capacity_leases', 'UPDATE')
          or has_table_privilege('infinite_canvas_recovery_test', 'provider_channel_capacity_policies', 'UPDATE')
          or has_table_privilege('infinite_canvas_recovery_test', 'generation_capacity_rate_windows', 'UPDATE')
          as recovery_can_update_capacity,
        has_table_privilege('infinite_canvas_api_test', 'provider_channel_capacity_policies', 'UPDATE')
          as api_can_update_capacity,
        has_table_privilege('infinite_canvas_worker_test', 'provider_channel_capacity_leases', 'UPDATE')
          and has_table_privilege('infinite_canvas_worker_test', 'generation_capacity_rate_windows', 'UPDATE')
          as worker_can_update_capacity
    `;
    assert.deepEqual(recoveryPrivileges[0], {
      claim: false,
      release: false,
      refresh_batch: false,
      helper: true,
      can_select: true,
      can_update: false,
      can_select_platform_idempotency: true,
      can_update_platform_idempotency: false,
      can_select_migrations: true,
      can_update_migrations: false,
      api_can_update_future_table: true,
      worker_can_update_future_table: true,
      recovery_can_select_capacity: true,
      recovery_can_update_capacity: false,
      api_can_update_capacity: true,
      worker_can_update_capacity: true,
    });
    const recoveryIdentity = await assertRuntimeDatabaseRole(recovery, "Integration recovery audit");
    assert.equal(recoveryIdentity.role, "infinite_canvas_recovery_test");
    assert.equal(recoveryIdentity.serviceAuthorized, true);
    const migrationCount = await recovery<{ count: number }[]>`select count(*)::int as count from app_schema_migrations`;
    assert.ok((migrationCount[0]?.count ?? 0) > 0);
    await assert.rejects(recovery`update app_schema_migrations set applied_at = applied_at`);
    await assert.rejects(recovery`select app.refresh_generation_batch(${randomUUID()})`, /permission denied/i);
    const identity = await assertRuntimeDatabaseRole(api, "Integration API");
    assert.equal(identity.role, "infinite_canvas_api_test");
    assert.equal(identity.serviceAuthorized, true);
    assert.equal(identity.superuser, false);
    assert.equal(identity.bypassRls, false);
    assert.equal(identity.ownsBusinessTables, false);

    await api.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into profiles (user_id, display_name) values (${userA}, 'A'), (${userB}, 'B')
        on conflict (user_id) do nothing
      `;
      await transaction`
        insert into workspaces (id, owner_user_id, name) values
          (${workspaceA}, ${userA}, 'Workspace A'), (${workspaceB}, ${userB}, 'Workspace B')
        on conflict (id) do nothing
      `;
      await transaction`
        insert into workspace_members (workspace_id, user_id, role) values
          (${workspaceA}, ${userA}, 'owner'), (${workspaceB}, ${userB}, 'owner')
        on conflict (workspace_id, user_id) do nothing
      `;
      await transaction`
        insert into projects (id, workspace_id, title, document_json, updated_by) values
          (${projectA}, ${workspaceA}, 'Project A', '{}'::jsonb, ${userA}),
          (${projectB}, ${workspaceB}, 'Project B', '{}'::jsonb, ${userB})
        on conflict (id) do nothing
      `;
    });

    const channelId = randomUUID();
    const modelId = randomUUID();
    const assetA = randomUUID();
    const assetB = randomUUID();
    const batchA = randomUUID();
    const batchB = randomUUID();
    const jobA = randomUUID();
    const jobB = randomUUID();
    const attemptA = randomUUID();
    const attemptB = randomUUID();
    await api.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into wallet_accounts (workspace_id, available, reserved)
        values (${workspaceA}, 100, 0), (${workspaceB}, 100, 0)
        on conflict (workspace_id) do nothing
      `;
      await transaction`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values
          (${assetA}, ${workspaceA}, 'image', 'ready', ${`${workspaceA}/asset-a.png`}, 'image/png', 8, ${"a".repeat(64)}),
          (${assetB}, ${workspaceB}, 'image', 'ready', ${`${workspaceB}/asset-b.png`}, 'image/png', 8, ${"b".repeat(64)})
      `;
      await transaction`
        insert into provider_channels (id, name, type, base_url, capabilities)
        values (${channelId}, 'RLS Provider', 'openai', 'https://provider.example', '["image"]'::jsonb)
      `;
      await transaction`
        insert into model_configs (id, channel_id, model, capability, adapter_type, adapter_version, config_version, limits_json, concurrency_limit)
        values (${modelId}, ${channelId}, 'rls-image', 'image', 'openai', 1, 1, '{}'::jsonb, 1)
      `;
      await transaction`
        insert into provider_channel_capacity_policies (
          channel_id, capability, version, concurrency_limit, rate_limit_per_minute
        ) values (${channelId}, 'image', 1, 1, 60)
      `;
      const requests = [randomUUID(), randomUUID()];
      await transaction`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values
          (${requests[0]!}, ${workspaceA}, 'batch.create', 'rls-batch-a', ${"c".repeat(64)}, now() + interval '1 day'),
          (${requests[1]!}, ${workspaceB}, 'batch.create', 'rls-batch-b', ${"d".repeat(64)}, now() + interval '1 day')
      `;
      await transaction`
        insert into generation_batches (id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by)
        values
          (${batchA}, ${workspaceA}, ${projectA}, 'image', 1, ${requests[0]!}, ${userA}),
          (${batchB}, ${workspaceB}, ${projectB}, 'image', 1, ${requests[1]!}, ${userB})
      `;
      await transaction`
        insert into generation_jobs (
          id, workspace_id, batch_id, slot_index, capability, model_config_id,
          model_snapshot, price_snapshot, input_snapshot, estimated_credits
        ) values
          (${jobA}, ${workspaceA}, ${batchA}, 0, 'image', ${modelId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1),
          (${jobB}, ${workspaceB}, ${batchB}, 0, 'image', ${modelId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1)
      `;
      await transaction`
        insert into generation_attempts (
          id, workspace_id, job_id, attempt_no, channel_id, credential_version,
          adapter_type, adapter_version, request_fingerprint, business_deadline_at,
          capacity_policy_version, workspace_concurrency_limit, workspace_rate_limit_per_minute,
          channel_concurrency_limit, channel_rate_limit_per_minute
        ) values
          (${attemptA}, ${workspaceA}, ${jobA}, 1, ${channelId}, 1, 'openai', 1, ${"e".repeat(64)}, now() + interval '1 hour', 1, 3, 30, 1, 60),
          (${attemptB}, ${workspaceB}, ${jobB}, 1, ${channelId}, 1, 'openai', 1, ${"f".repeat(64)}, now() + interval '1 hour', 1, 3, 30, 1, 60)
      `;
      await transaction`
        update generation_jobs set current_attempt_id = case id when ${jobA} then ${attemptA}::uuid else ${attemptB}::uuid end
        where id in (${jobA}, ${jobB})
      `;
      await transaction`select app.reserve_credits(${randomUUID()}, ${randomUUID()}, ${workspaceA}, ${jobA}, ${attemptA}, 1, now() + interval '1 day')`;
      await transaction`select app.reserve_credits(${randomUUID()}, ${randomUUID()}, ${workspaceB}, ${jobB}, ${attemptB}, 1, now() + interval '1 day')`;
      await transaction`
        insert into generation_job_events (workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload)
        values
          (${workspaceA}, 'job', ${jobA}, ${projectA}, ${batchA}, ${jobA}, ${attemptA}, 'generation.job.created', '{}'::jsonb),
          (${workspaceB}, 'job', ${jobB}, ${projectB}, ${batchB}, ${jobB}, ${attemptB}, 'generation.job.created', '{}'::jsonb)
      `;
    });

    await api.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'off', true), set_config('app.user_id', ${userA}, true)`;
      const visibility = await transaction<{
        projects: number;
        assets: number;
        jobs: number;
        events: number;
        wallets: number;
        ledger: number;
      }[]>`
        select
          (select count(*)::int from projects) as projects,
          (select count(*)::int from assets) as assets,
          (select count(*)::int from generation_jobs) as jobs,
          (select count(*)::int from generation_job_events) as events,
          (select count(*)::int from wallet_accounts) as wallets,
          (select count(*)::int from wallet_entries) as ledger
      `;
      assert.deepEqual(visibility[0], {
        projects: 1,
        assets: 1,
        jobs: 1,
        events: 1,
        wallets: 1,
        ledger: 1,
      });
      assert.deepEqual(
        await transaction<{ id: string }[]>`update assets set deleted_at = now() where id = ${assetB} returning id`,
        [],
      );
      assert.deepEqual(
        await transaction<{ id: string }[]>`update projects set title = 'cross-tenant-write' where id = ${projectB} returning id`,
        [],
      );
    });

    const assetId = randomUUID();
    const firstVerificationToken = randomUUID();
    const replacementVerificationToken = randomUUID();
    await api.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values (${assetId}, ${workspaceA}, 'image', 'uploading', ${`${workspaceA}/uploads/${assetId}.png`},
                'image/png', 8, ${"a".repeat(64)})
      `;
      const firstClaim = await transaction<{ id: string }[]>`
        update assets set status = 'verifying', verification_token = ${firstVerificationToken},
          updated_at = now() - interval '6 minutes'
        where id = ${assetId} and status = 'uploading' returning id
      `;
      assert.equal(firstClaim.length, 1);
      const replacementClaim = await transaction<{ id: string }[]>`
        update assets set verification_token = ${replacementVerificationToken}, updated_at = now()
        where id = ${assetId} and status = 'verifying'
          and updated_at < now() - interval '5 minutes' returning id
      `;
      assert.equal(replacementClaim.length, 1);
      const staleCompletion = await transaction<{ id: string }[]>`
        update assets set status = 'ready', verification_token = null, updated_at = now()
        where id = ${assetId} and status = 'verifying'
          and verification_token = ${firstVerificationToken} returning id
      `;
      assert.equal(staleCompletion.length, 0);
      const replacementCompletion = await transaction<{ id: string }[]>`
        update assets set status = 'ready', verification_token = null, updated_at = now()
        where id = ${assetId} and status = 'verifying'
          and verification_token = ${replacementVerificationToken} returning id
      `;
      assert.equal(replacementCompletion.length, 1);
    });

    const attackerCommands = await admin<{ command: string }[]>`
      select format('create role infinite_canvas_attacker_test login noinherit nosuperuser nobypassrls password %L', ${attackerPassword}::text) as command
      where not exists (select 1 from pg_roles where rolname = 'infinite_canvas_attacker_test')
      union all
      select format('alter role infinite_canvas_attacker_test with login noinherit nosuperuser nobypassrls password %L', ${attackerPassword}::text)
    `;
    for (const { command } of attackerCommands) await admin.unsafe(command);
    const databaseName = await admin<{ name: string }[]>`select quote_ident(current_database()) as name`;
    await admin.unsafe(`grant connect on database ${databaseName[0]!.name} to infinite_canvas_attacker_test`);
    await admin.unsafe("grant usage on schema public, app to infinite_canvas_attacker_test");
    await admin.unsafe("grant select, update on profiles, workspaces, workspace_members, projects to infinite_canvas_attacker_test");
    await admin.unsafe("grant execute on all functions in schema app to infinite_canvas_attacker_test");

    const attacker = postgres(roleUrl(adminUrl, "infinite_canvas_attacker_test", attackerPassword), { max: 1, prepare: false });
    try {
      await attacker`select set_config('app.user_id', '', false), set_config('app.service_role', 'on', false)`;
      const forged = await attacker<{ allowed: boolean }[]>`select app.has_workspace_access(${workspaceA}) as allowed`;
      assert.equal(forged[0]?.allowed, false);
      assert.deepEqual(await attacker<{ id: string }[]>`select id from projects order by id`, []);
      assert.deepEqual(await attacker<{ id: string }[]>`update projects set title = 'stolen' where id = ${projectA} returning id`, []);
    } finally {
      await attacker.end();
    }

    const listenerA = postgres(adminUrl, { max: 1, prepare: false });
    const listenerB = postgres(adminUrl, { max: 1, prepare: false });
    try {
      let resolveA!: (value: string) => void;
      let resolveB!: (value: string) => void;
      const receivedA = new Promise<string>((resolve) => { resolveA = resolve; });
      const receivedB = new Promise<string>((resolve) => { resolveB = resolve; });
      await Promise.all([
        listenerA.listen("integration_events", resolveA),
        listenerB.listen("integration_events", resolveB),
      ]);
      await admin`select pg_notify('integration_events', 'cursor:42')`;
      assert.deepEqual(await Promise.all([receivedA, receivedB]), ["cursor:42", "cursor:42"]);
    } finally {
      await listenerA.end();
      await listenerB.end();
    }
  } finally {
    await recovery.end();
    await api.end();
    await admin.end();
  }
});
