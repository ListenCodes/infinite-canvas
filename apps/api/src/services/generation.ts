import { createHash } from "node:crypto";

import {
  activeGenerationJobProjectionSchema,
  activeJobsSnapshotSchema,
  createGenerationBatchRequestSchema,
  createGenerationBatchResponseSchema,
  generationBatchSnapshotSchema,
  generationJobProjectionSchema,
  generationTaskListResponseSchema,
  generationTaskProjectionSchema,
  type CreateGenerationBatchRequest,
  type CreateGenerationBatchResponse,
  type GenerationBatchSnapshot,
  type GenerationJobProjection,
  type GenerationTaskListResponse,
  type ActiveJobsSnapshot,
  modelListResponseSchema,
} from "@infinite-canvas/contracts";
import { z } from "zod";

import type { Sql, TransactionSql } from "../database.js";
import { setServiceContext, setUserContext } from "../database.js";
import { AppError } from "../errors.js";
import type { IdFactory } from "../ids.js";
import { publicGenerationErrorMessage } from "../public-errors.js";

interface ProjectAccessRow {
  id: string;
  workspace_id: string;
  version: number;
  document_json: Record<string, unknown>;
}

const taskCursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  jobId: z.uuid(),
});

interface ModelRow {
  model_config_id: string;
  channel_id: string;
  model: string;
  adapter_type: string;
  adapter_version: number;
  config_version: number;
  limits_json: Record<string, unknown>;
  channel_type: string;
  base_url: string;
  credential_version: number;
  price_id: string;
  price_version: number;
  price_conditions: Record<string, unknown>;
  credit_amount: string;
  provider_idempotency_supported: boolean;
}

interface IdempotencyRow {
  id: string;
  request_hash: string;
  status: "processing" | "completed" | "failed";
  response_body: unknown;
}

interface GenerationFeatureRow {
  cloud_image_enabled: boolean;
  cloud_video_enabled: boolean;
  cloud_credits_enabled: boolean;
}

async function generationFeatures(
  transaction: TransactionSql,
  userId: string,
): Promise<GenerationFeatureRow> {
  const rows = await transaction<GenerationFeatureRow[]>`
    select cloud_image_enabled, cloud_video_enabled, cloud_credits_enabled
    from profiles where user_id = ${userId} and status = 'active'
  `;
  const flags = rows[0];
  if (!flags)
    throw new AppError(
      403,
      "feature_disabled",
      "Cloud generation is not enabled for this account",
    );
  return flags;
}

function assertGenerationEnabled(
  flags: GenerationFeatureRow,
  capability: "image" | "video",
): void {
  const capabilityEnabled =
    capability === "image"
      ? flags.cloud_image_enabled
      : flags.cloud_video_enabled;
  if (!flags.cloud_credits_enabled || !capabilityEnabled)
    throw new AppError(
      403,
      "feature_disabled",
      `Cloud ${capability} generation is not enabled for this account`,
    );
}

interface JobRow {
  batch_id: string;
  job_id: string;
  slot_index: number;
  slot_id: string;
  status: GenerationJobProjection["status"];
  job_version: number;
  attempt_id: string;
  attempt_no: number;
  output_asset_id: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ActiveJobRow extends JobRow {
  target_node_id: string;
  capability: "image" | "video";
}

function requestHash(input: CreateGenerationBatchRequest): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)))
    .digest("hex");
}

function projection(row: JobRow): GenerationJobProjection {
  return generationJobProjectionSchema.parse({
    batchId: row.batch_id,
    jobId: row.job_id,
    slotIndex: row.slot_index,
    slotId: row.slot_id,
    status: row.status,
    jobVersion: row.job_version,
    attemptId: row.attempt_id,
    attemptNo: row.attempt_no,
    ...(row.output_asset_id ? { assetId: row.output_asset_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_code
      ? { errorMessage: publicGenerationErrorMessage(row.error_code) }
      : {}),
  });
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function documentHasTarget(
  documentJson: Record<string, unknown>,
  nodeId: string,
  slotIds: readonly string[],
): boolean {
  const document = documentJson.document;
  if (!document || typeof document !== "object") return false;
  const nodes = (document as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return false;
  const node = nodes.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).id === nodeId,
  ) as Record<string, unknown> | undefined;
  if (!node) return false;
  const metadata = node.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const cloudSlotId = (metadata as Record<string, unknown>).cloudSlotId;
  if (slotIds.length === 1 && cloudSlotId === slotIds[0]) return true;
  const images = (metadata as Record<string, unknown>).images;
  if (!Array.isArray(images)) return false;
  const persistedSlots = new Set(
    images.flatMap((image) =>
      image &&
      typeof image === "object" &&
      typeof (image as Record<string, unknown>).id === "string"
        ? [(image as Record<string, unknown>).id as string]
        : [],
    ),
  );
  return slotIds.every((slotId) => persistedSlots.has(slotId));
}

function validateModelLimits(
  input: CreateGenerationBatchRequest,
  limits: Record<string, unknown>,
): void {
  if (typeof limits.maxCount === "number" && input.count > limits.maxCount)
    throw new AppError(
      422,
      "provider_parameter_rejected",
      "Requested output count exceeds the model limit",
    );
  if (
    typeof limits.maxReferenceAssets === "number" &&
    input.input.referenceAssetIds.length > limits.maxReferenceAssets
  ) {
    throw new AppError(
      422,
      "provider_parameter_rejected",
      "Reference asset count exceeds the model limit",
    );
  }
  if (
    Array.isArray(limits.sizes) &&
    input.input.size &&
    !limits.sizes.includes(input.input.size)
  ) {
    throw new AppError(
      422,
      "provider_parameter_rejected",
      "Requested size is not supported by the model",
    );
  }
  if (
    typeof limits.maxDurationSeconds === "number" &&
    input.input.durationSeconds &&
    input.input.durationSeconds > limits.maxDurationSeconds
  ) {
    throw new AppError(
      422,
      "provider_parameter_rejected",
      "Requested duration exceeds the model limit",
    );
  }
}

export class GenerationService {
  constructor(
    private readonly sql: Sql,
    private readonly createId: IdFactory,
    private readonly idempotencyTtlSeconds: number,
  ) {}

  async listModels(userId: string, capability?: "image" | "video") {
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const memberships = await transaction<{ allowed: boolean }[]>`
        select exists(
          select 1 from workspace_members
          where user_id = ${userId} and status = 'active'
        ) as allowed
      `;
      if (!memberships[0]?.allowed)
        throw new AppError(
          403,
          "workspace_access_forbidden",
          "No active workspace is available",
        );
      const flags = await generationFeatures(transaction, userId);
      if (!flags.cloud_credits_enabled) return [];
      if (capability) {
        if (
          (capability === "image" && !flags.cloud_image_enabled) ||
          (capability === "video" && !flags.cloud_video_enabled)
        )
          return [];
      }
      const rows = await transaction<
        {
          model_config_id: string;
          model: string;
          capability: "image" | "video";
          channel_name: string;
          provider_type: "grok2api" | "sub2api" | "openai";
          limits: Record<string, unknown>;
          unit_credits: string;
        }[]
      >`
        select config.id as model_config_id, config.model, config.capability,
               channel.name as channel_name, channel.type as provider_type,
               config.limits_json as limits, price.credit_amount::text as unit_credits
        from model_configs config
        join provider_channels channel on channel.id = config.channel_id and channel.status = 'active'
        join lateral (
          select credit_amount from model_prices
          where model_config_id = config.id and effective_at <= now()
            and (retired_at is null or retired_at > now())
          order by version desc limit 1
        ) price on true
        where config.status = 'active'
          and (${capability ?? null}::generation_capability is null or config.capability = ${capability ?? null}::generation_capability)
          and ((config.capability = 'image' and ${flags.cloud_image_enabled})
            or (config.capability = 'video' and ${flags.cloud_video_enabled}))
        order by config.capability, channel.name, config.model
      `;
      return modelListResponseSchema.parse(
        rows.map((row) => ({
          modelConfigId: row.model_config_id,
          model: row.model,
          capability: row.capability,
          channelName: row.channel_name,
          providerType: row.provider_type,
          limits: row.limits,
          unitCredits: row.unit_credits,
        })),
      );
    });
  }

  async createBatch(
    userId: string,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<CreateGenerationBatchResponse> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new AppError(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must contain 8 to 128 safe characters",
      );
    }
    const input = createGenerationBatchRequestSchema.parse(rawInput);
    const hash = requestHash(input);
    try {
      return await this.sql.begin(async (transaction) => {
        await setServiceContext(transaction);
        const projects = await transaction<ProjectAccessRow[]>`
          select project.id, project.workspace_id, project.version, project.document_json
          from projects project
          join workspace_members member on member.workspace_id = project.workspace_id
          join workspaces workspace on workspace.id = project.workspace_id and workspace.status = 'active'
          where project.id = ${input.projectId} and project.deleted_at is null
            and member.user_id = ${userId} and member.status = 'active'
            and member.role in ('owner', 'editor')
          for update of project
        `;
        const project = projects[0];
        if (!project)
          throw new AppError(404, "project_not_found", "Project was not found");
        let idempotency = await transaction<IdempotencyRow[]>`
          insert into idempotency_requests (
            id, workspace_id, operation, key, request_hash, expires_at
          ) values (
            ${this.createId()}, ${project.workspace_id}, 'batch.create', ${idempotencyKey}, ${hash},
            now() + (${this.idempotencyTtlSeconds}::text || ' seconds')::interval
          ) on conflict (workspace_id, operation, key) do nothing
          returning id, request_hash, status, response_body
        `;
        if (!idempotency[0]) {
          idempotency = await transaction<IdempotencyRow[]>`
            select id, request_hash, status, response_body
            from idempotency_requests
            where workspace_id = ${project.workspace_id} and operation = 'batch.create' and key = ${idempotencyKey}
            for update
          `;
        }
        const request = idempotency[0];
        if (!request) throw new Error("Idempotency claim failed");
        if (request.request_hash !== hash) {
          throw new AppError(
            409,
            "idempotency_key_conflict",
            "Idempotency-Key was already used with a different request",
          );
        }
        if (request.status === "completed")
          return request.response_body as CreateGenerationBatchResponse;
        if (request.status !== "processing") {
          throw new AppError(
            409,
            "idempotency_request_failed",
            "The previous request with this key failed",
          );
        }
        assertGenerationEnabled(
          await generationFeatures(transaction, userId),
          input.kind,
        );
        if (project.version !== input.projectVersion) {
          throw new AppError(
            409,
            "project_version_conflict",
            "Project has changed",
            { currentVersion: project.version },
          );
        }

        const models = await transaction<ModelRow[]>`
          select config.id as model_config_id, config.channel_id, config.model,
                 config.adapter_type, config.adapter_version, config.config_version, config.limits_json,
                 config.provider_idempotency_supported,
                 channel.type as channel_type, channel.base_url,
                 credential.version as credential_version,
                 price.id as price_id, price.version as price_version,
                 price.conditions_json as price_conditions, price.credit_amount::text
          from model_configs config
          join provider_channels channel on channel.id = config.channel_id and channel.status = 'active'
          join lateral (
            select version from provider_credentials
            where channel_id = channel.id and status = 'active'
            order by version desc limit 1
          ) credential on true
          join lateral (
            select id, version, conditions_json, credit_amount
            from model_prices
            where model_config_id = config.id and effective_at <= now()
              and (retired_at is null or retired_at > now())
            order by version desc limit 1
          ) price on true
          where config.id = ${input.modelConfigId} and config.capability = ${input.kind} and config.status = 'active'
        `;
        const model = models[0];
        if (!model)
          throw new AppError(
            422,
            "model_unavailable_or_unpriced",
            "The selected model is unavailable or has no active price",
          );
        validateModelLimits(input, model.limits_json);
        if (
          !documentHasTarget(
            project.document_json,
            input.target.nodeId,
            input.target.slotIds,
          )
        ) {
          throw new AppError(
            409,
            "project_target_conflict",
            "Generation target is not present in the saved project version",
          );
        }
        if (input.input.referenceAssetIds.length > 0) {
          const references = await transaction<{ id: string }[]>`
            select id from assets
            where workspace_id = ${project.workspace_id} and status = 'ready' and kind = 'image'
              and id in ${transaction(input.input.referenceAssetIds)}
          `;
          if (references.length !== input.input.referenceAssetIds.length) {
            throw new AppError(
              422,
              "reference_asset_unavailable",
              "One or more reference assets are unavailable in this workspace",
            );
          }
        }
        const unitCredits = BigInt(model.credit_amount);

        const batchId = this.createId();
        await transaction`
          insert into generation_batches (
            id, workspace_id, project_id, kind, requested_count, idempotency_request_id, created_by
          ) values (
            ${batchId}, ${project.workspace_id}, ${project.id}, ${input.kind}, ${input.count}, ${request.id}, ${userId}
          )
        `;

        const jobs: GenerationJobProjection[] = [];
        let eventCursor = "0";
        for (const [slotIndex, slotId] of input.target.slotIds.entries()) {
          const jobId = this.createId();
          const attemptId = this.createId();
          const reservationId = this.createId();
          const modelSnapshot = {
            model: model.model,
            channelType: model.channel_type,
            baseUrl: model.base_url,
            adapterType: model.adapter_type,
            adapterVersion: model.adapter_version,
            configVersion: model.config_version,
            limits: model.limits_json,
            providerIdempotencySupported: model.provider_idempotency_supported,
          };
          const priceSnapshot = {
            priceId: model.price_id,
            version: model.price_version,
            unitCredits: model.credit_amount,
            conditions: model.price_conditions,
          };
          const inputSnapshot = {
            input: input.input,
            target: {
              projectId: project.id,
              nodeId: input.target.nodeId,
              slotId,
            },
          };
          await transaction`
            insert into generation_jobs (
              id, workspace_id, batch_id, slot_index, capability, model_config_id,
              model_snapshot, price_snapshot, input_snapshot, estimated_credits
            ) values (
              ${jobId}, ${project.workspace_id}, ${batchId}, ${slotIndex}, ${input.kind}, ${model.model_config_id},
              ${JSON.stringify(modelSnapshot)}::jsonb, ${JSON.stringify(priceSnapshot)}::jsonb,
              ${JSON.stringify(inputSnapshot)}::jsonb, ${unitCredits.toString()}::bigint
            )
          `;
          await transaction`
            insert into generation_attempts (
              id, workspace_id, job_id, attempt_no, channel_id, credential_version,
              adapter_type, adapter_version, provider_idempotency_supported, request_fingerprint, business_deadline_at
            ) values (
              ${attemptId}, ${project.workspace_id}, ${jobId}, 1, ${model.channel_id}, ${model.credential_version},
              ${model.adapter_type}, ${model.adapter_version}, ${model.provider_idempotency_supported},
              ${hash}, now() + interval '30 minutes'
            )
          `;
          await transaction`update generation_jobs set current_attempt_id = ${attemptId} where id = ${jobId}`;
          await transaction`
            insert into generation_job_targets (job_id, workspace_id, project_id, node_id, slot_id)
            values (${jobId}, ${project.workspace_id}, ${project.id}, ${input.target.nodeId}, ${slotId})
          `;
          await transaction`
            select app.reserve_credits(
              ${reservationId}, ${this.createId()}, ${project.workspace_id}, ${jobId}, ${attemptId},
              ${unitCredits.toString()}::bigint, now() + interval '24 hours'
            )
          `;
          await transaction`
            insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
            values (
              ${this.createId()}, ${project.workspace_id}, 'generation.job.requested', ${jobId},
              ${`generation.job.requested:${attemptId}`},
              ${JSON.stringify({
                schemaVersion: 1,
                workflowName: "media-generation-v1",
                workspaceId: project.workspace_id,
                projectId: project.id,
                batchId,
                jobId,
                attemptId,
                capability: input.kind,
                channelId: model.channel_id,
              })}::jsonb
            )
          `;
          const event = await transaction<{ sequence: string }[]>`
            insert into generation_job_events (
              workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
            ) values (
              ${project.workspace_id}, 'job', ${jobId}, ${project.id}, ${batchId}, ${jobId}, ${attemptId},
              'generation.job.created',
              ${JSON.stringify({ slotIndex, slotId, attemptNo: 1, jobVersion: 0, status: "queued" })}::jsonb
            ) returning sequence::text
          `;
          eventCursor = event[0]?.sequence ?? eventCursor;
          jobs.push(
            generationJobProjectionSchema.parse({
              batchId,
              jobId,
              slotIndex,
              slotId,
              status: "queued",
              jobVersion: 0,
              attemptId,
              attemptNo: 1,
            }),
          );
        }
        const wallet = await transaction<{ available: string }[]>`
          select available::text from wallet_accounts where workspace_id = ${project.workspace_id}
        `;
        const response = createGenerationBatchResponseSchema.parse({
          batchId,
          status: "queued",
          jobs,
          credits: {
            reserved: (unitCredits * BigInt(input.count)).toString(),
            available: wallet[0]?.available ?? "0",
          },
          eventCursor,
        });
        await transaction`
          update idempotency_requests
          set status = 'completed', response_status = 202, response_body = ${JSON.stringify(response)}::jsonb, updated_at = now()
          where id = ${request.id}
        `;
        return response;
      });
    } catch (error) {
      if (databaseCode(error) === "P0001")
        throw new AppError(
          402,
          "insufficient_credits",
          "The workspace does not have enough credits",
        );
      throw error;
    }
  }

  async activeJobs(
    userId: string,
    projectId: string,
  ): Promise<ActiveJobsSnapshot> {
    return this.sql.begin("repeatable read read only", async (transaction) => {
      await setUserContext(transaction, userId);
      const projects = await transaction<
        { id: string; workspace_id: string; version: number }[]
      >`
        select project.id, project.workspace_id, project.version
        from projects project
        join workspace_members member on member.workspace_id = project.workspace_id
        where project.id = ${projectId} and project.deleted_at is null
          and member.user_id = ${userId} and member.status = 'active'
      `;
      const project = projects[0];
      if (!project)
        throw new AppError(
          404,
          "project_not_found",
          "Project was not found",
        );

      // Include the latest terminal job per target as well as active jobs. A task
      // may finish after the browser closes but before its local project metadata
      // is synchronized, and the snapshot must still be able to rebuild that slot.
      const rows = await transaction<ActiveJobRow[]>`
        select distinct on (target.node_id, target.slot_id)
          job.batch_id, job.id as job_id, job.slot_index, target.slot_id,
          target.node_id as target_node_id, job.capability, job.status,
          job.version as job_version, attempt.id as attempt_id,
          attempt.attempt_no, job.output_asset_id, attempt.error_code,
          attempt.error_message
        from generation_jobs job
        join generation_batches batch
          on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        join generation_job_targets target
          on target.workspace_id = job.workspace_id and target.job_id = job.id
        join generation_attempts attempt
          on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
        where batch.project_id = ${projectId}
        order by target.node_id, target.slot_id, job.created_at desc, job.id desc
      `;
      const cursor = await transaction<{ sequence: string }[]>`
        select coalesce(max(sequence), 0)::text as sequence
        from generation_job_events
        where workspace_id = ${project.workspace_id} and project_id = ${projectId}
      `;
      return activeJobsSnapshotSchema.parse({
        projectId,
        projectVersion: project.version,
        jobs: rows.map((row) =>
          activeGenerationJobProjectionSchema.parse({
            ...projection(row),
            targetNodeId: row.target_node_id,
            capability: row.capability,
          }),
        ),
        eventCursor: cursor[0]?.sequence ?? "0",
      });
    });
  }

  async getBatch(
    userId: string,
    batchId: string,
  ): Promise<GenerationBatchSnapshot> {
    return this.sql.begin("repeatable read read only", async (transaction) => {
      await setUserContext(transaction, userId);
      const batches = await transaction<
        {
          batch_id: string;
          project_id: string;
          status: GenerationBatchSnapshot["status"];
          requested_count: number;
        }[]
      >`
        select batch.id as batch_id, batch.project_id, batch.status, batch.requested_count
        from generation_batches batch
        join workspace_members member on member.workspace_id = batch.workspace_id
        where batch.id = ${batchId} and member.user_id = ${userId} and member.status = 'active'
      `;
      const batch = batches[0];
      if (!batch)
        throw new AppError(
          404,
          "generation_batch_not_found",
          "Generation batch was not found",
        );
      const jobs = await this.loadJobs(transaction, batchId, userId);
      const cursor = await transaction<{ sequence: string }[]>`
        select coalesce(max(event.sequence), 0)::text as sequence
        from generation_job_events event
        join workspace_members member on member.workspace_id = event.workspace_id
        where event.batch_id = ${batchId} and member.user_id = ${userId} and member.status = 'active'
      `;
      return generationBatchSnapshotSchema.parse({
        batchId: batch.batch_id,
        projectId: batch.project_id,
        status: batch.status,
        requestedCount: batch.requested_count,
        jobs,
        eventCursor: cursor[0]?.sequence ?? "0",
      });
    });
  }

  async resolveBatch(
    userId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<GenerationBatchSnapshot> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new AppError(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must contain 8 to 128 safe characters",
      );
    }
    const batchId = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      const rows = await transaction<{ batch_id: string }[]>`
        select batch.id as batch_id
        from generation_batches batch
        join idempotency_requests request
          on request.workspace_id = batch.workspace_id and request.id = batch.idempotency_request_id
        join workspace_members member on member.workspace_id = batch.workspace_id
        where batch.project_id = ${projectId}
          and request.operation = 'batch.create' and request.key = ${idempotencyKey}
          and member.user_id = ${userId} and member.status = 'active'
        limit 1
      `;
      return rows[0]?.batch_id;
    });
    if (!batchId)
      throw new AppError(
        404,
        "generation_batch_not_found",
        "Generation batch was not found",
      );
    return this.getBatch(userId, batchId);
  }

  async listJobs(
    userId: string,
    workspaceId?: string,
    before?: string,
    limit = 50,
  ): Promise<GenerationTaskListResponse> {
    let cursorCreatedAt: string | undefined;
    let cursorJobId: string | undefined;
    if (before) {
      try {
        const cursor = taskCursorSchema.parse(
          JSON.parse(Buffer.from(before, "base64url").toString("utf8")),
        );
        cursorCreatedAt = cursor.createdAt;
        cursorJobId = cursor.jobId;
      } catch {
        throw new AppError(
          400,
          "invalid_request",
          "The task cursor is invalid",
        );
      }
    }
    return this.sql.begin("repeatable read", async (transaction) => {
      await setUserContext(transaction, userId);
      const rows = await transaction<
        (JobRow & {
          project_id: string;
          workspace_id: string;
          capability: "image" | "video";
          created_at: Date;
          updated_at: Date;
        })[]
      >`
        select job.workspace_id, job.batch_id, job.id as job_id, job.slot_index, target.slot_id,
               job.status, job.version as job_version, attempt.id as attempt_id,
               attempt.attempt_no, job.output_asset_id, attempt.error_code, attempt.error_message,
               batch.project_id, job.capability, job.created_at, job.updated_at
        from generation_jobs job
        join generation_batches batch on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        join generation_job_targets target on target.workspace_id = job.workspace_id and target.job_id = job.id
        join generation_attempts attempt on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
        join workspace_members member on member.workspace_id = job.workspace_id
        where member.user_id = ${userId} and member.status = 'active'
          and (${workspaceId ?? null}::uuid is null or job.workspace_id = ${workspaceId ?? null}::uuid)
          and (${cursorCreatedAt ?? null}::timestamptz is null or
               (job.created_at, job.id) < (${cursorCreatedAt ?? null}::timestamptz, ${cursorJobId ?? null}::uuid))
        order by job.created_at desc, job.id desc
        limit ${limit + 1}
      `;
      const cursor = await transaction<{ sequence: string }[]>`
        select coalesce(max(event.sequence), 0)::text as sequence
        from generation_job_events event
        join workspace_members member on member.workspace_id = event.workspace_id
        where member.user_id = ${userId} and member.status = 'active'
          and (${workspaceId ?? null}::uuid is null or event.workspace_id = ${workspaceId ?? null}::uuid)
      `;
      const page = rows.slice(0, limit);
      return generationTaskListResponseSchema.parse({
        jobs: page.map((row) =>
          generationTaskProjectionSchema.parse({
            ...projection(row),
            workspaceId: row.workspace_id,
            projectId: row.project_id,
            capability: row.capability,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          }),
        ),
        eventCursor: cursor[0]?.sequence ?? "0",
        nextCursor:
          rows.length > limit && page.at(-1)
            ? Buffer.from(
                JSON.stringify({
                  createdAt: page.at(-1)!.created_at.toISOString(),
                  jobId: page.at(-1)!.job_id,
                }),
              ).toString("base64url")
            : null,
      });
    });
  }

  async retryJob(
    userId: string,
    jobId: string,
    idempotencyKey: string,
  ): Promise<GenerationJobProjection> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new AppError(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must contain 8 to 128 safe characters",
      );
    }
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const rows = await transaction<
        {
          workspace_id: string;
          batch_id: string;
          project_id: string;
          slot_index: number;
          slot_id: string;
          status: GenerationJobProjection["status"];
          version: number;
          estimated_credits: string;
          channel_id: string;
          credential_version: number;
          adapter_type: string;
          adapter_version: number;
          request_fingerprint: string;
          provider_idempotency_supported: boolean;
          capability: "image" | "video";
          attempt_no: number;
        }[]
      >`
        select job.workspace_id, job.batch_id, batch.project_id, job.slot_index, target.slot_id,
               job.capability,
               job.status, job.version, job.estimated_credits::text,
               attempt.channel_id, attempt.credential_version, attempt.adapter_type,
               attempt.adapter_version, attempt.provider_idempotency_supported,
               attempt.request_fingerprint, attempt.attempt_no
        from generation_jobs job
        join generation_batches batch on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        join generation_job_targets target on target.workspace_id = job.workspace_id and target.job_id = job.id
        join generation_attempts attempt on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
        join workspace_members member on member.workspace_id = job.workspace_id
        join workspaces workspace on workspace.id = job.workspace_id and workspace.status = 'active'
        join profiles profile on profile.user_id = member.user_id and profile.status = 'active'
        where job.id = ${jobId} and member.user_id = ${userId} and member.status = 'active'
          and member.role in ('owner', 'editor')
        for update of job, attempt
      `;
      const job = rows[0];
      if (!job)
        throw new AppError(
          404,
          "generation_job_not_found",
          "Generation job was not found",
        );
      const retryOperation = `job.retry:${jobId}`;
      const retryHash = createHash("sha256").update(jobId).digest("hex");
      let idempotency = await transaction<IdempotencyRow[]>`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values (
          ${this.createId()}, ${job.workspace_id}, ${retryOperation}, ${idempotencyKey}, ${retryHash},
          now() + (${this.idempotencyTtlSeconds}::text || ' seconds')::interval
        ) on conflict (workspace_id, operation, key) do nothing
        returning id, request_hash, status, response_body
      `;
      if (!idempotency[0]) {
        idempotency = await transaction<IdempotencyRow[]>`
          select id, request_hash, status, response_body from idempotency_requests
          where workspace_id = ${job.workspace_id} and operation = ${retryOperation} and key = ${idempotencyKey}
          for update
        `;
      }
      const retryRequest = idempotency[0];
      if (!retryRequest || retryRequest.request_hash !== retryHash) {
        throw new AppError(
          409,
          "idempotency_key_conflict",
          "Idempotency-Key was already used with a different request",
        );
      }
      if (retryRequest.status === "completed")
        return generationJobProjectionSchema.parse(retryRequest.response_body);
      assertGenerationEnabled(
        await generationFeatures(transaction, userId),
        job.capability,
      );
      if (
        !(["failed", "canceled"] as const).includes(
          job.status as "failed" | "canceled",
        )
      ) {
        throw new AppError(
          409,
          "generation_job_not_retryable",
          "Only failed or canceled slots can be retried",
        );
      }
      const attemptId = this.createId();
      const attemptNo = job.attempt_no + 1;
      await transaction`
        insert into generation_attempts (
          id, workspace_id, job_id, attempt_no, channel_id, credential_version,
          adapter_type, adapter_version, provider_idempotency_supported, request_fingerprint, business_deadline_at
        ) values (
          ${attemptId}, ${job.workspace_id}, ${jobId}, ${attemptNo}, ${job.channel_id}, ${job.credential_version},
          ${job.adapter_type}, ${job.adapter_version}, ${job.provider_idempotency_supported},
          ${job.request_fingerprint}, now() + interval '30 minutes'
        )
      `;
      await transaction`
        select app.reserve_credits(
          ${this.createId()}, ${this.createId()}, ${job.workspace_id}, ${jobId}, ${attemptId},
          ${job.estimated_credits}::bigint, now() + interval '24 hours'
        )
      `;
      const version = job.version + 1;
      await transaction`
        update generation_jobs
        set current_attempt_id = ${attemptId}, status = 'queued', output_asset_id = null,
            terminal_at = null, version = version + 1, updated_at = now()
        where id = ${jobId}
      `;
      await this.enqueueAttempt(
        transaction,
        job.workspace_id,
        job.project_id,
        job.batch_id,
        jobId,
        attemptId,
        job.channel_id,
      );
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
        ) values (
          ${job.workspace_id}, 'job', ${jobId}, ${job.project_id}, ${job.batch_id}, ${jobId}, ${attemptId},
          'generation.job.state_changed',
          ${JSON.stringify({ status: "queued", attemptNo, jobVersion: version, retry: true })}::jsonb
        )
      `;
      await transaction`select app.refresh_generation_batch(${job.batch_id})`;
      const response = generationJobProjectionSchema.parse({
        batchId: job.batch_id,
        jobId,
        slotIndex: job.slot_index,
        slotId: job.slot_id,
        status: "queued",
        jobVersion: version,
        attemptId,
        attemptNo,
      });
      await transaction`
        update idempotency_requests
        set status = 'completed', response_status = 202, response_body = ${JSON.stringify(response)}::jsonb, updated_at = now()
        where id = ${retryRequest.id}
      `;
      return response;
    });
  }

  async cancelJob(userId: string, jobId: string): Promise<{ status: string }> {
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const rows = await transaction<
        {
          workspace_id: string;
          project_id: string;
          batch_id: string;
          attempt_id: string;
          job_status: string;
          attempt_status: string;
          attempt_no: number;
          submitted_at: Date | null;
        }[]
      >`
        select job.workspace_id, batch.project_id, job.batch_id, attempt.id as attempt_id,
               job.status as job_status, attempt.status as attempt_status, attempt.attempt_no, attempt.submitted_at
        from generation_jobs job
        join generation_batches batch on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        join generation_attempts attempt on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
        join workspace_members member on member.workspace_id = job.workspace_id
        where job.id = ${jobId} and member.user_id = ${userId} and member.status = 'active'
          and member.role in ('owner', 'editor')
        for update of job, attempt
      `;
      const job = rows[0];
      if (!job)
        throw new AppError(
          404,
          "generation_job_not_found",
          "Generation job was not found",
        );
      if (["succeeded", "failed", "canceled"].includes(job.job_status))
        return { status: job.job_status };
      if (job.job_status === "cancel_requested")
        return { status: "cancel_requested" };

      if (job.attempt_status === "outcome_unknown") {
        await transaction`
          insert into audit_logs (id, workspace_id, actor_user_id, actor_type, action, target_type, target_id, reason, correlation_id)
          values (${this.createId()}, ${job.workspace_id}, ${userId}, 'user', 'generation.cancel_requested_while_unknown',
                  'attempt', ${job.attempt_id}, 'Cancellation cannot resolve an unknown provider acceptance outcome', ${`cancel-unknown:${job.attempt_id}`})
        `;
        return { status: "outcome_unknown" };
      }

      const accepted =
        job.submitted_at !== null ||
        ["submitting", "accepted", "materializing", "outcome_unknown"].includes(
          job.attempt_status,
        );
      const status = accepted ? "cancel_requested" : "canceled";
      if (!accepted) {
        await transaction`select app.release_reservation(${job.attempt_id}, ${this.createId()}, 'canceled_before_submit')`;
        await transaction`
          update generation_attempts set status = 'canceled', completed_at = now(), updated_at = now()
          where id = ${job.attempt_id}
        `;
      } else {
        await transaction`
          insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
          values (
            ${this.createId()}, ${job.workspace_id}, 'generation.job.cancel_requested', ${jobId},
            ${`generation.job.cancel_requested:${job.attempt_id}`},
            ${JSON.stringify({ jobId, attemptId: job.attempt_id })}::jsonb
          ) on conflict (dedupe_key) do nothing
        `;
      }
      const updatedJobs = await transaction<{ version: number }[]>`
        update generation_jobs
        set status = ${status}, version = version + 1, updated_at = now(),
            terminal_at = case when ${status} = 'canceled' then now() else null end
        where id = ${jobId}
        returning version
      `;
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
        ) values (
          ${job.workspace_id}, 'job', ${jobId}, ${job.project_id}, ${job.batch_id}, ${jobId}, ${job.attempt_id},
          'generation.job.cancel_requested', ${JSON.stringify({ status, attemptNo: job.attempt_no, jobVersion: updatedJobs[0]?.version })}::jsonb
        )
      `;
      await transaction`select app.refresh_generation_batch(${job.batch_id})`;
      return { status };
    });
  }

  private async loadJobs(
    transaction: TransactionSql,
    batchId: string,
    userId: string,
  ): Promise<GenerationJobProjection[]> {
    const rows = await transaction<JobRow[]>`
      select job.batch_id, job.id as job_id, job.slot_index, target.slot_id, job.status,
             job.version as job_version, attempt.id as attempt_id, attempt.attempt_no,
             job.output_asset_id, attempt.error_code, attempt.error_message
      from generation_jobs job
      join generation_job_targets target on target.workspace_id = job.workspace_id and target.job_id = job.id
      join generation_attempts attempt on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
      join workspace_members member on member.workspace_id = job.workspace_id
      where job.batch_id = ${batchId} and member.user_id = ${userId} and member.status = 'active'
      order by job.slot_index
    `;
    return rows.map(projection);
  }

  private async enqueueAttempt(
    transaction: TransactionSql,
    workspaceId: string,
    projectId: string,
    batchId: string,
    jobId: string,
    attemptId: string,
    channelId: string,
  ): Promise<void> {
    await transaction`
      insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
      select ${this.createId()}, ${workspaceId}, 'generation.job.requested', ${jobId},
             ${`generation.job.requested:${attemptId}`},
             jsonb_build_object(
               'schemaVersion', 1, 'workflowName', 'media-generation-v1',
               'workspaceId', ${workspaceId}::text, 'projectId', ${projectId}::text,
               'batchId', ${batchId}::text, 'jobId', ${jobId}::text,
               'attemptId', ${attemptId}::text, 'capability', job.capability,
               'channelId', ${channelId}::text
             )
      from generation_jobs job where job.id = ${jobId}
    `;
  }
}
