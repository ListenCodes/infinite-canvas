import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import postgres from "postgres";

import { EventBroker, EventService } from "./events.js";
import { AssetService } from "./services/assets.js";
import { GenerationService } from "./services/generation.js";
import { createProjectSchema, ProjectService } from "./services/projects.js";
import { AdminService } from "./services/admin.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;

function runtimeUrl(input: string): string {
  const parsed = new URL(input);
  parsed.username = "infinite_canvas_api_test";
  parsed.password = "integration-api-password-12345";
  return parsed.toString();
}

test("ten concurrent idempotent creates and failed-slot retries preserve exact cardinality", { skip: !adminUrl }, async () => {
  assert.ok(adminUrl);
  const sql = postgres(runtimeUrl(adminUrl), { max: 12, prepare: false });
  const userId = "00000000-0000-4000-8000-00000000c001";
  const workspaceId = "00000000-0000-4000-8000-00000000c101";
  const projectId = "00000000-0000-4000-8000-00000000c201";
  const channelId = "00000000-0000-4000-8000-00000000c301";
  const modelId = "00000000-0000-4000-8000-00000000c401";
  const priceId = "00000000-0000-4000-8000-00000000c501";
  const unauthorizedUserId = "00000000-0000-4000-8000-00000000b001";
  const slots = ["slot-1", "slot-2", "slot-3"];

  try {
    await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into profiles (
          user_id, display_name, cloud_projects_enabled, cloud_image_enabled,
          cloud_video_enabled, cloud_credits_enabled
        ) values (${userId}, 'Concurrency User', true, true, true, true)
        on conflict (user_id) do update
          set cloud_projects_enabled = true, cloud_image_enabled = true,
              cloud_video_enabled = true, cloud_credits_enabled = true
      `;
      await transaction`insert into workspaces (id, owner_user_id, name) values (${workspaceId}, ${userId}, 'Concurrency Workspace') on conflict do nothing`;
      await transaction`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'owner') on conflict do nothing`;
      await transaction`
        insert into projects (id, workspace_id, title, document_json, updated_by)
        values (
          ${projectId}, ${workspaceId}, 'Concurrency Project',
          ${JSON.stringify({ document: { nodes: [{ id: "node-1", metadata: { images: slots.map((id) => ({ id })) } }] } })}::jsonb,
          ${userId}
        ) on conflict do nothing
      `;
      await transaction`
        insert into provider_channels (id, name, type, base_url, capabilities)
        values (${channelId}, 'Integration Provider', 'grok2api', 'https://provider.example', '["image"]'::jsonb)
        on conflict do nothing
      `;
      await transaction`
        insert into provider_credentials (id, channel_id, version, encrypted_secret, encrypted_data_key, nonce, key_id, secret_suffix)
        values (${randomUUID()}, ${channelId}, 1, 'encrypted', 'encrypted-key', 'nonce', 'integration', 'test')
        on conflict (channel_id, version) do nothing
      `;
      await transaction`
        insert into model_configs (
          id, channel_id, model, capability, adapter_type, adapter_version, config_version,
          limits_json, concurrency_limit, provider_idempotency_supported
        ) values (${modelId}, ${channelId}, 'integration-image', 'image', 'grok2api', 1, 1, '{"maxCount":3}'::jsonb, 3, false)
        on conflict do nothing
      `;
      await transaction`
        insert into model_prices (id, model_config_id, version, conditions_json, credit_amount, effective_at)
        values (${priceId}, ${modelId}, 1, '{}'::jsonb, 10, now() - interval '1 minute') on conflict do nothing
      `;
      await transaction`
        insert into wallet_accounts (workspace_id, available, reserved)
        values (${workspaceId}, 1000, 0) on conflict (workspace_id) do update set available = 1000, reserved = 0
      `;
    });

    const service = new GenerationService(sql, randomUUID, 86_400);
    const request = {
      projectId,
      kind: "image",
      count: 3,
      target: { nodeId: "node-1", slotIds: slots },
      modelConfigId: modelId,
      input: { prompt: "draw three independent images", referenceAssetIds: [], parameters: { style: "clean", seed: 7 } },
      projectVersion: 1,
    };
    const responses = await Promise.all(Array.from({ length: 10 }, () => service.createBatch(userId, request, "batch-concurrency-key-0001")));
    assert.equal(new Set(responses.map(({ batchId }) => batchId)).size, 1);
    const batchId = responses[0]!.batchId;

    const counts = await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      return transaction<{
        batches: number; jobs: number; attempts: number; reservations: number; outbox: number;
        requests: number; available: string; reserved: string;
      }[]>`
        select
          (select count(*)::int from generation_batches where id = ${batchId}) as batches,
          (select count(*)::int from generation_jobs where batch_id = ${batchId}) as jobs,
          (select count(*)::int from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${batchId})) as attempts,
          (select count(*)::int from credit_reservations where job_id in (select id from generation_jobs where batch_id = ${batchId})) as reservations,
          (select count(*)::int from outbox_events where aggregate_id in (select id from generation_jobs where batch_id = ${batchId})) as outbox,
          (select count(*)::int from idempotency_requests where workspace_id = ${workspaceId} and operation = 'batch.create' and key = 'batch-concurrency-key-0001') as requests,
          (select available::text from wallet_accounts where workspace_id = ${workspaceId}) as available,
          (select reserved::text from wallet_accounts where workspace_id = ${workspaceId}) as reserved
      `;
    });
    assert.deepEqual(counts[0], { batches: 1, jobs: 3, attempts: 3, reservations: 3, outbox: 3, requests: 1, available: "970", reserved: "30" });

    await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`update projects set version = 2 where id = ${projectId}`;
    });
    assert.equal((await service.createBatch(userId, request, "batch-concurrency-key-0001")).batchId, batchId);

    const initialJobs = responses[0]!.jobs;
    const succeeded = initialJobs[0]!;
    const failed = initialJobs.slice(1);
    const assetId = randomUUID();
    await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values (${assetId}, ${workspaceId}, 'image', 'ready', ${`${workspaceId}/generated/${succeeded.attemptId}.png`}, 'image/png', 10, ${"a".repeat(64)})
      `;
      await transaction`select app.settle_reservation(${succeeded.attemptId}, ${randomUUID()})`;
      await transaction`update generation_attempts set status = 'succeeded', completed_at = now() where id = ${succeeded.attemptId}`;
      await transaction`update generation_jobs set status = 'succeeded', output_asset_id = ${assetId}, terminal_at = now(), version = version + 1 where id = ${succeeded.jobId}`;
      for (const [index, job] of failed.entries()) {
        const errorCode = index === 0 ? "provider_rate_limited" : "content_moderation_rejected";
        const errorMessage = index === 0 ? "Provider capacity was exhausted" : "Prompt was rejected by moderation";
        await transaction`select app.release_reservation(${job.attemptId}, ${randomUUID()}, ${errorCode})`;
        await transaction`update generation_attempts set status = 'failed', completed_at = now(), error_code = ${errorCode}, error_message = ${errorMessage} where id = ${job.attemptId}`;
        await transaction`update generation_jobs set status = 'failed', terminal_at = now(), version = version + 1 where id = ${job.jobId}`;
      }
      await transaction`select app.refresh_generation_batch(${batchId})`;
    });

    const beforeRetry = await service.getBatch(userId, batchId);
    assert.equal(beforeRetry.status, "partial_succeeded");
    assert.deepEqual(
      failed.map((job) => beforeRetry.jobs.find((candidate) => candidate.slotId === job.slotId)?.errorCode),
      ["provider_rate_limited", "content_moderation_rejected"],
    );
    await Promise.all(failed.map((job, index) => service.retryJob(userId, job.jobId, `failed-slot-retry-key-000${index}`)));
    await Promise.all(failed.map((job, index) => service.retryJob(userId, job.jobId, `failed-slot-retry-key-000${index}`)));
    const afterRetry = await service.getBatch(userId, batchId);
    const preserved = afterRetry.jobs.find(({ jobId }) => jobId === succeeded.jobId);
    assert.equal(preserved?.attemptId, succeeded.attemptId);
    assert.equal(preserved?.assetId, assetId);
    const projectJobs = await service.activeJobs(userId, projectId);
    assert.equal(projectJobs.projectVersion, 2);
    assert.equal(projectJobs.jobs.length, 3);
    assert.deepEqual(
      new Set(projectJobs.jobs.map((job) => job.targetNodeId)),
      new Set(["node-1"]),
    );
    assert.deepEqual(
      new Set(projectJobs.jobs.map((job) => job.slotId)),
      new Set(slots),
    );
    await assert.rejects(
      service.activeJobs(unauthorizedUserId, projectId),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "project_not_found",
    );

    const attemptCount = await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      return transaction<{ count: number }[]>`
        select count(*)::int as count from generation_attempts
        where job_id in (select id from generation_jobs where batch_id = ${batchId})
      `;
    });
    assert.equal(attemptCount[0]?.count, 5);

    const listenerA = postgres(runtimeUrl(adminUrl), { max: 1, prepare: false });
    const listenerB = postgres(runtimeUrl(adminUrl), { max: 1, prepare: false });
    const brokerA = new EventBroker(listenerA);
    const brokerB = new EventBroker(listenerB);
    try {
      await Promise.all([brokerA.start(), brokerB.start()]);
      let resolveA!: (value: { workspaceId: string; sequence: string }) => void;
      let resolveB!: (value: { workspaceId: string; sequence: string }) => void;
      const notifiedA = new Promise<{ workspaceId: string; sequence: string }>((resolve) => { resolveA = resolve; });
      const notifiedB = new Promise<{ workspaceId: string; sequence: string }>((resolve) => { resolveB = resolve; });
      const unsubscribeA = brokerA.subscribe(resolveA);
      const unsubscribeB = brokerB.subscribe(resolveB);
      const inserted = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ sequence: string }[]>`
          insert into generation_job_events (
            workspace_id, aggregate_type, aggregate_id, project_id, batch_id, type, payload
          ) values (
            ${workspaceId}, 'batch', ${batchId}, ${projectId}, ${batchId}, 'generation.batch.updated',
            '{"status":"running"}'::jsonb
          ) returning sequence::text
        `;
      });
      const sequence = inserted[0]!.sequence;
      const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("LISTEN/NOTIFY timeout")), 5_000));
      assert.deepEqual(await Promise.race([Promise.all([notifiedA, notifiedB]), timeout]), [
        { workspaceId, sequence },
        { workspaceId, sequence },
      ]);
      unsubscribeA();
      unsubscribeB();

      const events = new EventService(sql);
      const replayed = await events.after(userId, workspaceId, "0", projectId);
      assert.equal(replayed.some((event) => event.sequence === sequence && event.type === "generation.batch.updated"), true);
      assert.deepEqual(await events.after(userId, workspaceId, sequence, projectId), []);
      assert.deepEqual(await events.after(unauthorizedUserId, workspaceId, "0", projectId), []);
      await assert.rejects(
        events.workspaceForUser(unauthorizedUserId, projectId, workspaceId),
        (error: unknown) =>
          typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404,
      );

      let signedUrlCalls = 0;
      let signedUploadCalls = 0;
      const assetService = new AssetService(
        sql,
        {
          storage: {
            from() {
              return {
                async createSignedUploadUrl() {
                  signedUploadCalls += 1;
                  return {
                    data: {
                      signedUrl: "https://storage.example/upload",
                      token: "integration-upload-token",
                    },
                    error: null,
                  };
                },
                async createSignedUrl() {
                  signedUrlCalls += 1;
                  return { data: { signedUrl: "https://storage.example/signed" }, error: null };
                },
              };
            },
          },
        } as never,
        "integration-assets",
        1024,
        randomUUID,
        { maxImagePixels: 1_000_000, maxDurationSeconds: 60, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" },
      );
      await assert.rejects(
        assetService.signedDownload(unauthorizedUserId, assetId),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "asset_not_found",
      );
      assert.equal(signedUrlCalls, 0);

      const projectService = new ProjectService(sql, randomUUID);
      const createProjectInput = createProjectSchema.parse({
        workspaceId,
        clientProjectId: "local-idempotent-project",
        title: "Idempotent cloud project",
        documentJson: {
          schemaVersion: 1 as const,
          localProjectId: "local-idempotent-project",
          document: { nodes: [], connections: [] },
        },
      });
      const createdProjects = await Promise.all(
        Array.from({ length: 10 }, () =>
          projectService.create(
            userId,
            createProjectInput,
            "project-create-local-idempotent-project",
          ),
        ),
      );
      assert.equal(new Set(createdProjects.map(({ id }) => id)).size, 1);
      assert.equal(
        (
          await projectService.create(
            userId,
            { ...createProjectInput, title: "A newer local title" },
            "project-create-local-idempotent-project",
          )
        ).id,
        createdProjects[0]!.id,
      );
      await assert.rejects(
        projectService.create(
          userId,
          {
            ...createProjectInput,
            documentJson: {
              ...createProjectInput.documentJson,
              localProjectId: "different-local-project",
            },
            clientProjectId: "different-local-project",
          },
          "project-create-local-idempotent-project",
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "idempotency_key_conflict",
      );
      const secondWorkspaceId = randomUUID();
      const foreignWorkspaceId = randomUUID();
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          insert into workspaces (id, owner_user_id, name) values
            (${secondWorkspaceId}, ${userId}, 'Second writable workspace'),
            (${foreignWorkspaceId}, ${unauthorizedUserId}, 'Foreign workspace')
        `;
        await transaction`
          insert into workspace_members (workspace_id, user_id, role) values
            (${secondWorkspaceId}, ${userId}, 'owner'),
            (${foreignWorkspaceId}, ${unauthorizedUserId}, 'owner')
        `;
      });
      const secondWorkspaceInput = createProjectSchema.parse({
        ...createProjectInput,
        workspaceId: secondWorkspaceId,
        clientProjectId: "local-second-workspace",
        documentJson: {
          ...createProjectInput.documentJson,
          localProjectId: "local-second-workspace",
        },
      });
      const secondWorkspaceProject = await projectService.create(
        userId,
        secondWorkspaceInput,
        "project-create-second-workspace",
      );
      assert.equal(secondWorkspaceProject.workspaceId, secondWorkspaceId);
      assert.equal(
        (await projectService.create(userId, secondWorkspaceInput, "project-create-second-workspace")).id,
        secondWorkspaceProject.id,
      );
      await assert.rejects(
        projectService.create(
          userId,
          createProjectSchema.parse({
            ...createProjectInput,
            workspaceId: foreignWorkspaceId,
            clientProjectId: "local-foreign-workspace",
            documentJson: {
              ...createProjectInput.documentJson,
              localProjectId: "local-foreign-workspace",
            },
          }),
          "project-create-foreign-workspace",
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "workspace_write_forbidden",
      );

      const uploadInput = {
        kind: "image" as const,
        mime: "image/png" as const,
        bytes: "8",
        sha256: "9".repeat(64),
        filename: "reference.png",
      };
      const uploadIntents = await Promise.all(
        Array.from({ length: 10 }, () =>
          assetService.createUploadIntent(
            userId,
            uploadInput,
            `asset-upload:${uploadInput.sha256}`,
          ),
        ),
      );
      assert.equal(new Set(uploadIntents.map(({ assetId: id }) => id)).size, 1);
      const uploadAssetId = uploadIntents[0]!.assetId;
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update assets set status = 'ready' where id = ${uploadAssetId}`;
      });
      const signedCallsBeforeReadyReplay = signedUploadCalls;
      const readyReplay = await assetService.createUploadIntent(
        userId,
        { ...uploadInput, filename: "renamed-reference.png" },
        `asset-upload:${uploadInput.sha256}`,
      );
      assert.equal(readyReplay.assetId, uploadAssetId);
      assert.equal(readyReplay.status, "ready");
      assert.equal(signedUploadCalls, signedCallsBeforeReadyReplay);

      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update profiles set platform_role = 'admin' where user_id = ${userId}`;
      });
      const idempotencyAdminService = new AdminService(
        sql,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        1000n,
        randomUUID,
      );
      const channelKey = "admin-channel-create-lost-response-0001";
      const channelResponses = await Promise.all(
        Array.from({ length: 10 }, () =>
          idempotencyAdminService.saveChannel(
            userId,
            {
              name: "Idempotent Provider",
              type: "openai",
              baseUrl: "https://1.1.1.1",
              capabilities: ["image"],
            },
            channelKey,
          ),
        ),
      );
      const idempotentChannelId = channelResponses[0]!.id;
      assert.equal(new Set(channelResponses.map(({ id }) => id)).size, 1);
      await assert.rejects(
        idempotencyAdminService.saveChannel(
          userId,
          {
            name: "Different Provider",
            type: "openai",
            baseUrl: "https://1.1.1.1",
            capabilities: ["image"],
          },
          channelKey,
        ),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "idempotency_key_conflict",
      );
      const credentialKey = "admin-credential-rotate-lost-response-0001";
      const credentialA = await idempotencyAdminService.rotateCredential(
        userId,
        idempotentChannelId,
        { secret: "integration-provider-secret-12345" },
        credentialKey,
      );
      const credentialB = await idempotencyAdminService.rotateCredential(
        userId,
        idempotentChannelId,
        { secret: "integration-provider-secret-12345" },
        credentialKey,
      );
      assert.deepEqual(credentialB, credentialA);
      const modelKey = "admin-model-create-lost-response-0001";
      const modelInput = {
        model: "integration-idempotent-image",
        capability: "image" as const,
        adapterType: "openai",
        adapterVersion: 1,
        concurrencyLimit: 2,
        providerIdempotencySupported: false,
        creditAmount: "3",
        limits: { maxCount: 3 },
      };
      const modelA = await idempotencyAdminService.createModel(userId, idempotentChannelId, modelInput, modelKey);
      const modelB = await idempotencyAdminService.createModel(userId, idempotentChannelId, modelInput, modelKey);
      assert.deepEqual(modelB, modelA);
      const adminIdempotencyCounts = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ requests: number; channels: number; credentials: number; models: number }[]>`
          select
            (select count(*)::int from platform_idempotency_requests where actor_user_id = ${userId}) as requests,
            (select count(*)::int from provider_channels where id = ${idempotentChannelId}) as channels,
            (select count(*)::int from provider_credentials where channel_id = ${idempotentChannelId}) as credentials,
            (select count(*)::int from model_configs where id = ${modelA.modelConfigId}) as models
        `;
      });
      assert.deepEqual(adminIdempotencyCounts[0], { requests: 3, channels: 1, credentials: 1, models: 1 });
      const paginationTimestamp = "2026-08-10T00:00:00.000Z";
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          insert into profiles (user_id, display_name, created_at)
          select md5('pagination-user-' || value)::uuid, 'Pagination User ' || value, ${paginationTimestamp}::timestamptz
          from generate_series(1, 501) value
        `;
        await transaction`
          insert into audit_logs (id, actor_type, action, target_type, target_id, reason, correlation_id, created_at)
          select md5('pagination-audit-' || value)::uuid, 'system', 'pagination.fixture', 'fixture',
                 md5('pagination-target-' || value)::uuid, 'pagination fixture', 'pagination-audit-' || value,
                 ${paginationTimestamp}::timestamptz
          from generate_series(1, 501) value
        `;
        await transaction`update generation_jobs set created_at = ${paginationTimestamp}::timestamptz where workspace_id = ${workspaceId}`;
      });
      const collectPages = async <T>(
        load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
      ): Promise<T[]> => {
        const items: T[] = [];
        let cursor: string | undefined;
        do {
          const page = await load(cursor);
          items.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return items;
      };
      const pagedUsers = await collectPages((cursor) => idempotencyAdminService.usersPage({ cursor, limit: 100 }));
      const fixtureUsers = pagedUsers.filter((item) => String(item.displayName).startsWith("Pagination User "));
      assert.equal(fixtureUsers.length, 501);
      assert.equal(new Set(fixtureUsers.map((item) => item.userId)).size, 501);
      const pagedAudit = await collectPages((cursor) => idempotencyAdminService.auditPage({ cursor, limit: 100 }));
      const fixtureAudit = pagedAudit.filter((item) => item.action === "pagination.fixture");
      assert.equal(fixtureAudit.length, 501);
      assert.equal(new Set(fixtureAudit.map((item) => item.id)).size, 501);
      const pagedJobs = await collectPages((cursor) => idempotencyAdminService.jobsPage({ cursor, limit: 2 }));
      const expectedJobIds = new Set(afterRetry.jobs.map((job) => job.jobId));
      assert.deepEqual(
        new Set(pagedJobs.filter((item) => expectedJobIds.has(item.jobId)).map((item) => item.jobId)),
        expectedJobIds,
      );
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update profiles set platform_role = 'user' where user_id = ${userId}`;
      });

      await assert.rejects(
        projectService.update(unauthorizedUserId, projectId, {
          version: 2,
          title: "cross-tenant-update",
          documentJson: { schemaVersion: 1, localProjectId: "foreign", document: {} },
        }),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "project_not_found",
      );
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update workspaces set status = 'suspended' where id = ${workspaceId}`;
      });
      const assertCode = (code: string) => (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === code;
      await assert.rejects(
        projectService.create(
          userId,
          {
            ...createProjectInput,
            documentJson: { ...createProjectInput.documentJson, localProjectId: "suspended-project" },
            clientProjectId: "suspended-project",
          },
          "project-create-suspended-workspace",
        ),
        assertCode("workspace_write_forbidden"),
      );
      await assert.rejects(
        assetService.createUploadIntent(
          userId,
          { ...uploadInput, sha256: "8".repeat(64) },
          `asset-upload:${"8".repeat(64)}`,
        ),
        assertCode("workspace_write_forbidden"),
      );
      await assert.rejects(
        service.createBatch(
          userId,
          { ...request, projectVersion: 2 },
          "batch-suspended-workspace-0001",
        ),
        assertCode("project_not_found"),
      );
      const queuedJob = afterRetry.jobs.find((job) => job.status === "queued");
      assert.ok(queuedJob);
      await assert.rejects(
        service.retryJob(userId, queuedJob.jobId, "retry-suspended-workspace-0001"),
        assertCode("generation_job_not_found"),
      );
      assert.equal((await service.cancelJob(userId, queuedJob.jobId)).status, "canceled");
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update workspaces set status = 'active' where id = ${workspaceId}`;
      });
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update profiles
          set cloud_projects_enabled = false, cloud_image_enabled = false,
              cloud_video_enabled = false, cloud_credits_enabled = false
          where user_id = ${userId}
        `;
      });
      assert.deepEqual(await service.listModels(userId, "image"), []);
      await assert.rejects(
        service.createBatch(
          userId,
          { ...request, projectVersion: 2 },
          "feature-disabled-batch-0001",
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "feature_disabled",
      );
      await assert.rejects(
        projectService.update(userId, projectId, {
          version: 2,
          title: "disabled-rollout-write",
          documentJson: {
            schemaVersion: 1,
            localProjectId: "feature-disabled",
            document: {},
          },
        }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "feature_disabled",
      );
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update profiles set status = 'disabled', platform_role = 'admin'
          where user_id = ${userId}
        `;
      });
      const adminService = new AdminService(
        sql,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        1000n,
        randomUUID,
      );
      const walletBeforeRejectedAdmin = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ available: string; reserved: string }[]>`
          select available::text, reserved::text from wallet_accounts
          where workspace_id = ${workspaceId}
        `;
      });
      await assert.rejects(
        adminService.adjustWallet(
          userId,
          {
            workspaceId,
            amount: "1",
            reason: "disabled admin must not mutate wallet",
            confirmLargeDebit: false,
          },
          "disabled-admin-wallet-0001",
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "admin_required",
      );
      const walletAfterRejectedAdmin = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ available: string; reserved: string }[]>`
          select available::text, reserved::text from wallet_accounts
          where workspace_id = ${workspaceId}
        `;
      });
      assert.deepEqual(walletAfterRejectedAdmin, walletBeforeRejectedAdmin);
    } finally {
      await brokerA.close();
      await brokerB.close();
    }
  } finally {
    await sql.end();
  }
});
