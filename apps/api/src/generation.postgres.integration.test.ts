import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import postgres from "postgres";
import { generationWorkflowInputSchema } from "@infinite-canvas/contracts";

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
  const providerCreateWorkspaceId = "00000000-0000-4000-8000-00000000c102";
  const providerCreateProjectId = "00000000-0000-4000-8000-00000000c202";
  const channelId = "00000000-0000-4000-8000-00000000c301";
  const modelId = "00000000-0000-4000-8000-00000000c401";
  const priceId = "00000000-0000-4000-8000-00000000c501";
  const providerCreateChannelId = "00000000-0000-4000-8000-00000000c302";
  const providerCreateModelId = "00000000-0000-4000-8000-00000000c402";
  const providerCreatePriceId = "00000000-0000-4000-8000-00000000c502";
  const unauthorizedUserId = "00000000-0000-4000-8000-00000000b001";
  const slots = ["slot-1", "slot-2", "slot-3"];
  const providerCreateSlots = ["provider-create-slot-1", "provider-create-slot-2", "provider-create-slot-3"];

  try {
    await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        insert into profiles (
          user_id, display_name, cloud_projects_enabled, cloud_image_enabled,
          cloud_video_enabled, cloud_credits_enabled
        ) values
          (${userId}, 'Concurrency User', true, true, true, true),
          (${unauthorizedUserId}, 'Cross-tenant User', true, false, false, false)
        on conflict (user_id) do update
          set cloud_projects_enabled = excluded.cloud_projects_enabled,
              cloud_image_enabled = excluded.cloud_image_enabled,
              cloud_video_enabled = excluded.cloud_video_enabled,
              cloud_credits_enabled = excluded.cloud_credits_enabled
      `;
      await transaction`insert into workspaces (id, owner_user_id, name) values (${workspaceId}, ${userId}, 'Concurrency Workspace') on conflict do nothing`;
      await transaction`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'owner') on conflict do nothing`;
      await transaction`insert into workspaces (id, owner_user_id, name) values (${providerCreateWorkspaceId}, ${userId}, 'Provider Create Gate Workspace') on conflict do nothing`;
      await transaction`insert into workspace_members (workspace_id, user_id, role) values (${providerCreateWorkspaceId}, ${userId}, 'owner') on conflict do nothing`;
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
        insert into provider_channels (id, name, type, base_url, capabilities)
        values (${providerCreateChannelId}, 'Provider Create Gate', 'grok2api', 'https://provider-create.example', '["image"]'::jsonb)
        on conflict do nothing
      `;
      await transaction`
        insert into provider_credentials (id, channel_id, version, encrypted_secret, encrypted_data_key, nonce, key_id, secret_suffix)
        values (${randomUUID()}, ${providerCreateChannelId}, 1, 'encrypted', 'encrypted-key', 'nonce', 'integration', 'gate')
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
        insert into provider_channel_capacity_policies (
          channel_id, capability, version, concurrency_limit, rate_limit_per_minute
        ) values (${channelId}, 'image', 1, 3, 60)
        on conflict do nothing
      `;
      await transaction`
        insert into model_configs (
          id, channel_id, model, capability, adapter_type, adapter_version, config_version,
          limits_json, concurrency_limit, provider_idempotency_supported
        ) values (${providerCreateModelId}, ${providerCreateChannelId}, 'provider-create-image', 'image', 'grok2api', 1, 1, '{"maxCount":3}'::jsonb, 3, false)
        on conflict do nothing
      `;
      await transaction`
        insert into provider_channel_capacity_policies (
          channel_id, capability, version, concurrency_limit, rate_limit_per_minute
        ) values (${providerCreateChannelId}, 'image', 1, 3, 60)
        on conflict do nothing
      `;
      await transaction`
        insert into model_prices (id, model_config_id, version, conditions_json, credit_amount, effective_at)
        values (${priceId}, ${modelId}, 1, '{}'::jsonb, 10, now() - interval '1 minute') on conflict do nothing
      `;
      await transaction`
        insert into model_prices (id, model_config_id, version, conditions_json, credit_amount, effective_at)
        values (${providerCreatePriceId}, ${providerCreateModelId}, 1, '{}'::jsonb, 10, now() - interval '1 minute') on conflict do nothing
      `;
      await transaction`
        insert into wallet_accounts (workspace_id, available, reserved)
        values (${workspaceId}, 1000, 0) on conflict (workspace_id) do update set available = 1000, reserved = 0
      `;
      await transaction`
        insert into wallet_accounts (workspace_id, available, reserved)
        values (${providerCreateWorkspaceId}, 1000, 0) on conflict (workspace_id) do update set available = 1000, reserved = 0
      `;
    });

    const setupIds = [
      randomUUID(), projectId, randomUUID(),
      randomUUID(), providerCreateProjectId, randomUUID(),
    ];
    const setupProjectService = new ProjectService(sql, () => {
      const id = setupIds.shift();
      assert.ok(id, "project fixture exhausted its deterministic identifiers");
      return id;
    });
    const createdProject = await setupProjectService.create(userId, createProjectSchema.parse({
      workspaceId,
      clientProjectId: "concurrency-project",
      title: "Concurrency Project",
      documentJson: {
        schemaVersion: 1,
        localProjectId: "concurrency-project",
        document: { nodes: [{ id: "node-1", metadata: { images: slots.map((id) => ({ id })) } }] },
      },
    }), "project-create-concurrency-project");
    const providerCreateProject = await setupProjectService.create(userId, createProjectSchema.parse({
      workspaceId: providerCreateWorkspaceId,
      clientProjectId: "provider-create-gate-project",
      title: "Provider Create Gate Project",
      documentJson: {
        schemaVersion: 1,
        localProjectId: "provider-create-gate-project",
        document: { nodes: [{ id: "provider-create-node", metadata: { images: providerCreateSlots.map((id) => ({ id })) } }] },
      },
    }), "project-create-provider-create-gate");
    assert.equal(createdProject.id, projectId);
    assert.equal(providerCreateProject.id, providerCreateProjectId);

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
        batches: number; jobs: number; attempts: number; reservations: number; outbox: number; pendingV2: number;
        requests: number; capacitySnapshots: number; capacityPayloads: number;
        available: string; reserved: string;
      }[]>`
        select
          (select count(*)::int from generation_batches where id = ${batchId}) as batches,
          (select count(*)::int from generation_jobs where batch_id = ${batchId}) as jobs,
          (select count(*)::int from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${batchId})) as attempts,
          (select count(*)::int from credit_reservations where job_id in (select id from generation_jobs where batch_id = ${batchId})) as reservations,
          (select count(*)::int from outbox_events where aggregate_id in (select id from generation_jobs where batch_id = ${batchId})) as outbox,
          (select count(*)::int from idempotency_requests where workspace_id = ${workspaceId} and operation = 'batch.create' and key = 'batch-concurrency-key-0001') as requests,
          (select count(*)::int from generation_attempts
             where job_id in (select id from generation_jobs where batch_id = ${batchId})
               and capacity_policy_version = 1 and workspace_concurrency_limit = 3
               and workspace_rate_limit_per_minute = 30 and channel_concurrency_limit = 3
               and channel_rate_limit_per_minute = 60) as "capacitySnapshots",
           (select count(*)::int from outbox_events
              where aggregate_id in (select id from generation_jobs where batch_id = ${batchId})
                and payload->>'schemaVersion' = '2'
                and payload->>'workflowName' = 'media-generation-v2'
                and payload->'capacity' = jsonb_build_object(
                 'policyVersion', 1, 'workspaceConcurrencyLimit', 3,
                 'workspaceRateLimitPerMinute', 30, 'channelConcurrencyLimit', 3,
                 'channelRateLimitPerMinute', 60
               )) as "capacityPayloads",
          (select available::text from wallet_accounts where workspace_id = ${workspaceId}) as available,
          (select reserved::text from wallet_accounts where workspace_id = ${workspaceId}) as reserved
      `;
    });
    assert.deepEqual(counts[0], {
      batches: 1, jobs: 3, attempts: 3, reservations: 3, outbox: 3, requests: 1,
      capacitySnapshots: 3, capacityPayloads: 3, available: "970", reserved: "30",
    });

    const providerCreateRequest = {
      ...request,
      projectId: providerCreateProjectId,
      modelConfigId: providerCreateModelId,
      target: { nodeId: "provider-create-node", slotIds: providerCreateSlots },
      input: { ...request.input, prompt: "prove the provider create upper bound" },
    };
    const providerCreateResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.createBatch(userId, providerCreateRequest, "batch-provider-create-cap-0001"),
      ),
    );
    assert.equal(new Set(providerCreateResponses.map(({ batchId: id }) => id)).size, 1);
    const providerCreateBatchId = providerCreateResponses[0]!.batchId;
    const providerCreateCounts = await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        update outbox_events
        set available_at = now() + interval '1 day'
        where aggregate_id in (select id from generation_jobs where batch_id = ${providerCreateBatchId})
          and topic = 'generation.job.requested'
      `;
      return transaction<{
        batches: number; jobs: number; attempts: number; reservations: number; outbox: number;
        requests: number; available: string; reserved: string;
      }[]>`
        select
          (select count(*)::int from generation_batches where id = ${providerCreateBatchId}) as batches,
          (select count(*)::int from generation_jobs where batch_id = ${providerCreateBatchId}) as jobs,
          (select count(*)::int from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${providerCreateBatchId})) as attempts,
          (select count(*)::int from credit_reservations where job_id in (select id from generation_jobs where batch_id = ${providerCreateBatchId})) as reservations,
          (select count(*)::int from outbox_events where aggregate_id in (select id from generation_jobs where batch_id = ${providerCreateBatchId})) as outbox,
          (select count(*)::int from outbox_events where aggregate_id in (select id from generation_jobs where batch_id = ${providerCreateBatchId}) and status = 'pending' and payload->>'schemaVersion' = '2') as "pendingV2",
          (select count(*)::int from idempotency_requests where workspace_id = ${providerCreateWorkspaceId} and operation = 'batch.create' and key = 'batch-provider-create-cap-0001') as requests,
          (select available::text from wallet_accounts where workspace_id = ${providerCreateWorkspaceId}) as available,
          (select reserved::text from wallet_accounts where workspace_id = ${providerCreateWorkspaceId}) as reserved
      `;
    });
    assert.deepEqual(providerCreateCounts[0], {
      batches: 1, jobs: 3, attempts: 3, reservations: 3, outbox: 3, pendingV2: 3,
      requests: 1, available: "970", reserved: "30",
    });

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
    const retryCapacity = await sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      return transaction<{ valid: number }[]>`
        select count(*)::int as valid
        from generation_jobs job
        join generation_attempts attempt on attempt.id = job.current_attempt_id
        join outbox_events event on event.aggregate_id = job.id
          and event.payload->>'attemptId' = attempt.id::text
        where job.id in ${transaction(failed.map(({ jobId }) => jobId))}
          and attempt.attempt_no = 2
          and attempt.capacity_policy_version = 1
          and attempt.workspace_concurrency_limit = 3
          and attempt.workspace_rate_limit_per_minute = 30
          and attempt.channel_concurrency_limit = 3
          and attempt.channel_rate_limit_per_minute = 60
          and event.payload->>'schemaVersion' = '2'
          and event.payload->>'workflowName' = 'media-generation-v2'
          and event.payload->'capacity' = jsonb_build_object(
            'policyVersion', 1, 'workspaceConcurrencyLimit', 3,
            'workspaceRateLimitPerMinute', 30, 'channelConcurrencyLimit', 3,
            'channelRateLimitPerMinute', 60
          )
      `;
    });
    assert.equal(retryCapacity[0]?.valid, 2);
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
      const unknownCandidate = afterRetry.jobs.find(({ jobId }) => jobId === failed[0]!.jobId);
      assert.ok(unknownCandidate);
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update generation_attempts
          set status = 'outcome_unknown', business_deadline_at = now() - interval '2 hours',
              outcome_unknown_at = now() - interval '1 hour', reconcile_after = now(),
              release_after = now() + interval '23 hours', error_code = 'provider_outcome_unknown'
          where id = ${unknownCandidate.attemptId}
        `;
        await transaction`
          update generation_jobs set status = 'outcome_unknown', version = version + 1
          where id = ${unknownCandidate.jobId}
        `;
      });
      const resolvedUnknown = await idempotencyAdminService.resolveUnknown(
        userId,
        unknownCandidate.attemptId,
        {
          resolution: "accepted",
          providerTaskId: "provider-task-confirmed-0001",
          reason: "Provider console confirms task acceptance",
          evidence: { source: "provider_console", reference: "case-accepted-0001" },
        },
        "unknown-accepted-resolution-0001",
      );
      assert.equal(resolvedUnknown.status, "waiting_provider");
      const reconciled = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          attempt_status: string;
          job_status: string;
          provider_task_id: string;
          deadline_extended: boolean;
          reconcile_after: Date | null;
          release_after: Date | null;
          reservation_status: string;
          recovery_outbox: number;
          recovery_payload: unknown;
          capacity_policy_version: number;
          workspace_concurrency_limit: number;
          workspace_rate_limit_per_minute: number;
          channel_concurrency_limit: number;
          channel_rate_limit_per_minute: number;
        }[]>`
          select attempt.status as attempt_status, job.status as job_status, attempt.provider_task_id,
                 attempt.business_deadline_at >= now() + interval '29 minutes' as deadline_extended,
                 attempt.reconcile_after, attempt.release_after, reservation.status as reservation_status,
                 (select count(*)::int from outbox_events event
                  where event.aggregate_id = job.id and event.dedupe_key = 'generation.job.reconciled:' || attempt.id::text || ':unknown-accepted-resolution-0001') as recovery_outbox,
                 (select event.payload from outbox_events event
                  where event.aggregate_id = job.id and event.dedupe_key = 'generation.job.reconciled:' || attempt.id::text || ':unknown-accepted-resolution-0001') as recovery_payload,
                 attempt.capacity_policy_version, attempt.workspace_concurrency_limit,
                 attempt.workspace_rate_limit_per_minute, attempt.channel_concurrency_limit,
                 attempt.channel_rate_limit_per_minute
          from generation_attempts attempt
          join generation_jobs job on job.current_attempt_id = attempt.id
          join credit_reservations reservation on reservation.attempt_id = attempt.id
          where attempt.id = ${unknownCandidate.attemptId}
        `;
      });
      const { recovery_payload: recoveryPayload, ...reconciledState } = reconciled[0]!;
      assert.deepEqual(reconciledState, {
        attempt_status: "accepted",
        job_status: "waiting_provider",
        provider_task_id: "provider-task-confirmed-0001",
        deadline_extended: true,
        reconcile_after: null,
        release_after: null,
        reservation_status: "reserved",
        recovery_outbox: 1,
        capacity_policy_version: 1,
        workspace_concurrency_limit: 3,
        workspace_rate_limit_per_minute: 30,
        channel_concurrency_limit: 3,
        channel_rate_limit_per_minute: 60,
      });
      const recoveryInput = generationWorkflowInputSchema.parse(recoveryPayload);
      assert.deepEqual(recoveryInput, {
        schemaVersion: 2,
        workflowName: "media-generation-v2",
        workspaceId,
        projectId,
        batchId,
        jobId: unknownCandidate.jobId,
        attemptId: unknownCandidate.attemptId,
        capability: "image",
        channelId,
        capacity: {
          policyVersion: reconciledState.capacity_policy_version,
          workspaceConcurrencyLimit: reconciledState.workspace_concurrency_limit,
          workspaceRateLimitPerMinute: reconciledState.workspace_rate_limit_per_minute,
          channelConcurrencyLimit: reconciledState.channel_concurrency_limit,
          channelRateLimitPerMinute: reconciledState.channel_rate_limit_per_minute,
        },
      });
      const reconciledProjection = (await idempotencyAdminService.jobsPage({ limit: 100 })).items.find(
        (item) => item.attemptId === unknownCandidate.attemptId,
      );
      assert.ok(reconciledProjection);
      assert.equal(reconciledProjection.channelId, channelId);
      assert.deepEqual(reconciledProjection.evidence, { source: "provider_console", reference: "case-accepted-0001" });
      assert.equal(reconciledProjection.reservationStatus, "reserved");
      assert.equal(reconciledProjection.reservedCredits, "10");
      assert.ok(reconciledProjection.outbox.length > 0);
      assert.deepEqual(reconciledProjection.ledgerKinds, ["reserve"]);
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
        rateLimitPerMinute: 45,
        providerIdempotencySupported: false,
        creditAmount: "3",
        limits: { maxCount: 3 },
      };
      const modelA = await idempotencyAdminService.createModel(userId, idempotentChannelId, modelInput, modelKey);
      const modelB = await idempotencyAdminService.createModel(userId, idempotentChannelId, modelInput, modelKey);
      assert.deepEqual(modelB, modelA);
      await idempotencyAdminService.createModel(
        userId,
        idempotentChannelId,
        { ...modelInput, model: "integration-idempotent-image-2" },
        "admin-model-create-same-capacity-0002",
      );
      const adminIdempotencyCounts = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          requests: number; channels: number; credentials: number; models: number;
          policies: number; concurrencyLimit: number; rateLimitPerMinute: number;
        }[]>`
          select
            (select count(*)::int from platform_idempotency_requests where actor_user_id = ${userId}) as requests,
            (select count(*)::int from provider_channels where id = ${idempotentChannelId}) as channels,
            (select count(*)::int from provider_credentials where channel_id = ${idempotentChannelId}) as credentials,
            (select count(*)::int from model_configs where channel_id = ${idempotentChannelId}) as models,
            (select count(*)::int from provider_channel_capacity_policies
              where channel_id = ${idempotentChannelId} and capability = 'image') as policies,
            (select concurrency_limit from provider_channel_capacity_policies
              where channel_id = ${idempotentChannelId} and capability = 'image' order by version desc limit 1) as "concurrencyLimit",
            (select rate_limit_per_minute from provider_channel_capacity_policies
              where channel_id = ${idempotentChannelId} and capability = 'image' order by version desc limit 1) as "rateLimitPerMinute"
        `;
      });
      assert.deepEqual(adminIdempotencyCounts[0], {
        requests: 4, channels: 1, credentials: 1, models: 2,
        policies: 1, concurrencyLimit: 2, rateLimitPerMinute: 45,
      });
      const paginationTimestamp = "2026-08-10T00:00:00.000Z";
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          with fixture as (
            select value, md5('pagination-user-' || value) as digest
            from generate_series(1, 501) value
          )
          insert into profiles (user_id, display_name, created_at)
          select (
                   substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-4' ||
                   substr(digest, 14, 3) || '-8' || substr(digest, 18, 3) || '-' || substr(digest, 21, 12)
                 )::uuid,
                 'Pagination User ' || value,
                 ${paginationTimestamp}::timestamptz
          from fixture
        `;
        await transaction`
          with fixture as (
            select value,
                   md5('pagination-audit-' || value) as audit_digest,
                   md5('pagination-target-' || value) as target_digest
            from generate_series(1, 501) value
          )
          insert into audit_logs (id, actor_type, action, target_type, target_id, reason, correlation_id, created_at)
          select (
                   substr(audit_digest, 1, 8) || '-' || substr(audit_digest, 9, 4) || '-4' ||
                   substr(audit_digest, 14, 3) || '-8' || substr(audit_digest, 18, 3) || '-' || substr(audit_digest, 21, 12)
                 )::uuid,
                 'system', 'pagination.fixture', 'fixture',
                 (
                   substr(target_digest, 1, 8) || '-' || substr(target_digest, 9, 4) || '-4' ||
                   substr(target_digest, 14, 3) || '-8' || substr(target_digest, 18, 3) || '-' || substr(target_digest, 21, 12)
                 )::uuid,
                 'pagination fixture', 'pagination-audit-' || value,
                 ${paginationTimestamp}::timestamptz
          from fixture
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
        await transaction`
          update workspaces set status = 'suspended'
          where id in (${workspaceId}, ${secondWorkspaceId}, ${providerCreateWorkspaceId})
        `;
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
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update workspaces set status = 'active'
          where id in (${secondWorkspaceId}, ${providerCreateWorkspaceId})
        `;
      });
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
