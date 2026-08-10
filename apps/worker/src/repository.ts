import type postgres from "postgres";

import {
  assetIdSchema,
  channelIdSchema,
  generationWorkflowInputSchema,
  type GenerationWorkflowInput,
} from "@infinite-canvas/contracts";
import {
  AdapterRegistry,
  type FrozenGenerationInput,
  type ProviderContext,
  type ProviderState,
} from "@infinite-canvas/provider-adapters";

import type { WorkerConfig } from "./config.js";
import { decryptCredential } from "./credential-vault.js";
import type { ObjectStorage } from "./storage.js";
import type { AttemptExecution, MaterializedAsset } from "./types.js";

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

interface ExecutionRow {
  status: string;
  provider_task_id: string | null;
  provider_idempotency_supported: boolean;
  business_deadline_at: Date;
  evidence_json: Record<string, unknown> | null;
  channel_id: string;
  base_url: string;
  adapter_type: string;
  adapter_version: number;
  capability: "image" | "video";
  model_snapshot: {
    model: string;
  };
  input_snapshot: {
    input: {
      prompt: string;
      parameters?: Record<string, string | number | boolean | null>;
      referenceAssetIds?: string[];
    };
  };
  encrypted_secret: string;
  encrypted_data_key: string;
  nonce: string;
}

async function serviceContext(sql: TransactionSql): Promise<void> {
  await sql`select set_config('app.service_role', 'on', true)`;
}

async function updateBatchStatus(
  sql: TransactionSql,
  batchId: string,
): Promise<void> {
  await sql`select app.refresh_generation_batch(${batchId})`;
}

export class GenerationRepository {
  constructor(
    private readonly sql: Sql,
    private readonly config: WorkerConfig,
    private readonly registry: AdapterRegistry,
    private readonly storage: ObjectStorage,
    private readonly createId: () => string,
    private readonly observeProviderRequest?: (observation: {
      code: string;
      durationSeconds: number;
    }) => void,
  ) {}

  async claim(
    input: GenerationWorkflowInput,
    workflowRunId: string,
    dispatchToken: string,
  ): Promise<"claimed" | "duplicate" | "terminal"> {
    return this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<
        { result: "claimed" | "duplicate" | "terminal" }[]
      >`
        select app.claim_generation_attempt(
          ${input.workspaceId}, ${input.projectId}, ${input.batchId}, ${input.jobId},
          ${input.attemptId}, ${input.channelId}, ${input.capability}::generation_capability,
          ${dispatchToken}::uuid, ${workflowRunId}
        ) as result
      `;
      return rows[0]?.result ?? "terminal";
    });
  }

  async load(
    inputValue: GenerationWorkflowInput,
    signal: AbortSignal,
    executorClaimId: string,
  ): Promise<AttemptExecution> {
    const input = generationWorkflowInputSchema.parse(inputValue);
    const rows = await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      return transaction<ExecutionRow[]>`
        select attempt.status, attempt.provider_task_id, attempt.provider_idempotency_supported,
               attempt.evidence_json, attempt.business_deadline_at,
               attempt.channel_id, channel.base_url, attempt.adapter_type, attempt.adapter_version,
               job.capability, job.model_snapshot, job.input_snapshot,
               credential.encrypted_secret, credential.encrypted_data_key, credential.nonce
        from generation_attempts attempt
        join generation_jobs job on job.workspace_id = attempt.workspace_id and job.id = attempt.job_id
        join generation_batches batch on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        join provider_channels channel on channel.id = attempt.channel_id
        join provider_credentials credential
          on credential.channel_id = attempt.channel_id and credential.version = attempt.credential_version
        where attempt.id = ${input.attemptId} and attempt.workspace_id = ${input.workspaceId}
          and attempt.job_id = ${input.jobId} and attempt.channel_id = ${input.channelId}
          and attempt.executor_claim_id = ${executorClaimId}
          and job.current_attempt_id = attempt.id and job.batch_id = ${input.batchId}
          and job.capability = ${input.capability}::generation_capability and batch.project_id = ${input.projectId}
      `;
    });
    const row = rows[0];
    if (!row)
      throw new Error(
        "Generation attempt is no longer current or does not exist",
      );
    const referenceIds = row.input_snapshot.input.referenceAssetIds ?? [];
    const referenceRows =
      referenceIds.length === 0
        ? []
        : await this.sql.begin(async (transaction) => {
            await serviceContext(transaction);
            return transaction<
              { id: string; object_key: string; mime: string }[]
            >`
        select id, object_key, mime from assets
        where workspace_id = ${input.workspaceId} and status = 'ready' and id in ${transaction(referenceIds)}
      `;
          });
    if (referenceRows.length !== referenceIds.length)
      throw new Error("One or more reference assets are unavailable");
    const referenceMap = new Map(
      referenceRows.map((asset) => [asset.id, asset]),
    );
    const referenceAssets = await Promise.all(
      referenceIds.map(async (id) => {
        const asset = referenceMap.get(id);
        if (!asset) throw new Error("Reference asset lookup lost ordering");
        return {
          assetId: assetIdSchema.parse(id),
          url: await this.storage.signedReferenceUrl(asset.object_key),
          mime: asset.mime,
        };
      }),
    );
    const generation: FrozenGenerationInput = {
      prompt: row.input_snapshot.input.prompt,
      model: row.model_snapshot.model,
      capability: row.capability,
      parameters: row.input_snapshot.input.parameters ?? {},
      referenceAssetIds: referenceIds.map((id) => assetIdSchema.parse(id)),
      referenceAssets,
    };
    const provider: ProviderContext = {
      channelId: channelIdSchema.parse(row.channel_id),
      baseUrl: new URL(row.base_url),
      credential: decryptCredential(
        this.config.CREDENTIAL_MASTER_KEY,
        row.encrypted_data_key,
        row.encrypted_secret,
        row.nonce,
      ),
      signal,
      ...(row.provider_idempotency_supported
        ? { idempotencyKey: input.attemptId }
        : {}),
      trustedMediaOrigins: [this.storage.trustedOrigin()],
      ...(this.observeProviderRequest
        ? { observeRequest: this.observeProviderRequest }
        : {}),
    };
    return {
      input,
      status: row.status,
      providerTaskId: row.provider_task_id,
      providerIdempotencySupported: row.provider_idempotency_supported,
      businessDeadlineAt: row.business_deadline_at,
      evidence: row.evidence_json,
      generation,
      provider,
      adapter: this.registry.get(
        row.adapter_type,
        row.adapter_version,
        row.capability,
      ),
    };
  }

  async reconcileUnknownProviderTask(
    candidate: {
      attempt_id: string;
      workspace_id: string;
      job_id: string;
      batch_id: string;
      project_id: string;
      channel_id: string;
      capability: "image" | "video";
      provider_task_id: string | null;
      release_after: Date;
    },
    now: Date,
  ): Promise<boolean> {
    const providerTaskId = candidate.provider_task_id;
    if (!providerTaskId) return false;
    const executorClaimId = `unknown-reconcile:${this.createId()}`;
    const input = generationWorkflowInputSchema.parse({
      schemaVersion: 1,
      workflowName: "media-generation-v1",
      workspaceId: candidate.workspace_id,
      projectId: candidate.project_id,
      batchId: candidate.batch_id,
      jobId: candidate.job_id,
      attemptId: candidate.attempt_id,
      capability: candidate.capability,
      channelId: candidate.channel_id,
    });
    const claimed = await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      return transaction<{ id: string }[]>`
        update generation_attempts attempt
        set executor_claim_id = ${executorClaimId}, updated_at = now()
        from generation_jobs job, generation_batches batch
        where attempt.id = ${input.attemptId} and attempt.workspace_id = ${input.workspaceId}
          and attempt.status = 'outcome_unknown' and attempt.executor_claim_id is null
          and attempt.provider_task_id = ${providerTaskId}
          and attempt.reconcile_after <= ${now} and attempt.release_after > ${now}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
          and job.batch_id = ${input.batchId} and job.capability = ${input.capability}::generation_capability
          and batch.id = job.batch_id and batch.workspace_id = job.workspace_id
          and batch.project_id = ${input.projectId}
        returning attempt.id
      `;
    });
    if (!claimed[0]) return false;

    let state: ProviderState;
    try {
      const execution = await this.load(
        input,
        AbortSignal.timeout(30_000),
        executorClaimId,
      );
      if (!execution.adapter.poll)
        throw new Error("Adapter has no authoritative provider task query");
      state = await execution.adapter.poll(
        providerTaskId,
        execution.provider,
      );
    } catch (error) {
      await this.finishUnknownReconcile(
        input,
        executorClaimId,
        now,
        "provider_query_failed",
        error instanceof Error ? error.message : "Provider task query failed",
      );
      return true;
    }

    if (state.status === "pending") {
      await this.finishUnknownReconcile(
        input,
        executorClaimId,
        now,
        "provider_task_pending",
        "Provider task remains pending",
      );
      return true;
    }
    if (state.status === "failed" || state.status === "canceled") {
      await this.sql.begin(async (transaction) => {
        await serviceContext(transaction);
        const attempts = await transaction<{ id: string }[]>`
          update generation_attempts attempt
          set status = ${state.status === "canceled" ? "canceled" : "failed"}::attempt_status,
              completed_at = now(), error_code = ${state.status === "failed" ? state.errorCode : "provider_canceled"},
              error_message = ${state.status === "failed" ? state.message : "Provider confirmed cancellation during reconciliation"},
              executor_claim_id = null, executor_run_id = null, updated_at = now()
          from generation_jobs job
          where attempt.id = ${input.attemptId} and attempt.status = 'outcome_unknown'
            and attempt.executor_claim_id = ${executorClaimId}
            and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
          returning attempt.id
        `;
        if (!attempts[0]) return;
        await transaction`select app.release_reservation(${input.attemptId}, ${this.createId()}, 'provider_reconciled_terminal')`;
        const jobStatus = state.status === "canceled" ? "canceled" : "failed";
        await transaction`
          update generation_jobs set status = ${jobStatus}::job_status, version = version + 1,
            terminal_at = now(), updated_at = now()
          where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
        `;
        await this.writeStateEvent(
          transaction,
          input,
          jobStatus,
          state.status === "failed" ? state.errorCode : "provider_canceled",
          state.status === "failed" ? state.message : "Provider confirmed cancellation during reconciliation",
        );
        await transaction`
          insert into audit_logs (id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id)
          values (${this.createId()}, ${input.workspaceId}, 'system', 'outcome_unknown.provider_terminal', 'attempt', ${input.attemptId},
                  ${state.status === "failed" ? state.message.slice(0, 500) : "Provider confirmed cancellation"},
                  ${`unknown-provider-terminal:${input.attemptId}:${this.createId()}`})
        `;
        await updateBatchStatus(transaction, input.batchId);
      });
      return true;
    }

    const mediaUrl = state.mediaUrls[0];
    if (!mediaUrl) {
      await this.finishUnknownReconcile(
        input,
        executorClaimId,
        now,
        "provider_success_without_media",
        "Provider reported success without a media URL",
      );
      return true;
    }
    const nextDispatchToken = this.createId();
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const attempts = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'materializing', evidence_json = ${JSON.stringify({ mediaUrls: [mediaUrl.toString()] })}::jsonb,
            executor_claim_id = null, executor_run_id = null, reconcile_after = null,
            executor_dispatch_token = ${nextDispatchToken}::uuid,
            error_code = null, error_message = null, updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status = 'outcome_unknown'
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!attempts[0]) return;
      await transaction`
        update outbox_events
        set status = 'sent', sent_at = coalesce(sent_at, now()),
            last_error = 'superseded by a newer recovery dispatch generation',
            locked_by = null, locked_at = null, updated_at = now()
        where workspace_id = ${input.workspaceId} and aggregate_id = ${input.jobId}
          and topic = 'generation.job.requested' and status in ('pending', 'sending')
          and payload->>'attemptId' = ${input.attemptId}
          and dispatch_started_token is not null
          and dispatch_started_token <> ${nextDispatchToken}::uuid
      `;
      const jobs = await transaction<{ status: string }[]>`
        update generation_jobs
        set status = case when status = 'cancel_requested' then status else 'materializing'::job_status end,
            version = version + 1, updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
        returning status
      `;
      await transaction`
        insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
        values (${this.createId()}, ${input.workspaceId}, 'generation.job.requested', ${input.jobId},
                ${`generation.job.unknown-recovered:${input.attemptId}`}, ${JSON.stringify(input)}::jsonb)
        on conflict (dedupe_key) do update
          set status = 'pending', attempts = 0, available_at = now(), dispatch_started_token = null, last_error = null,
              locked_by = null, locked_at = null, sent_at = null, updated_at = now()
      `;
      await this.writeStateEvent(transaction, input, jobs[0]?.status ?? "materializing");
      await transaction`
        insert into audit_logs (id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id)
        values (${this.createId()}, ${input.workspaceId}, 'system', 'outcome_unknown.provider_succeeded', 'attempt', ${input.attemptId},
                'Provider task succeeded; deterministic materialization recovery was scheduled',
                ${`unknown-provider-succeeded:${input.attemptId}`})
      `;
      await updateBatchStatus(transaction, input.batchId);
    });
    return true;
  }

  private async finishUnknownReconcile(
    input: GenerationWorkflowInput,
    executorClaimId: string,
    now: Date,
    result: string,
    reason: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const attempts = await transaction<{ id: string }[]>`
        update generation_attempts
        set executor_claim_id = null,
            reconcile_after = least(release_after, ${new Date(now.getTime() + 60 * 60 * 1000)}),
            evidence_json = coalesce(evidence_json, '{}'::jsonb) ||
              jsonb_build_object('lastReconciledAt', ${now.toISOString()}, 'reconciliation', ${result}),
            updated_at = now()
        where id = ${input.attemptId} and status = 'outcome_unknown'
          and executor_claim_id = ${executorClaimId}
        returning id
      `;
      if (!attempts[0]) return;
      await transaction`
        insert into audit_logs (id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id)
        values (${this.createId()}, ${input.workspaceId}, 'system', 'outcome_unknown.reconcile', 'attempt', ${input.attemptId},
                ${reason.slice(0, 500)}, ${`reconcile:${input.attemptId}:${now.toISOString()}`})
      `;
    });
  }

  async markSubmitting(
    input: GenerationWorkflowInput,
    executorClaimId: string,
  ): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'submitting', submitted_at = now(), updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status = 'claimed'
          and attempt.executor_claim_id = ${executorClaimId}
          and job.workspace_id = attempt.workspace_id and job.id = attempt.job_id
          and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (rows[0]) {
        await transaction`
          update generation_jobs set status = 'running', version = version + 1, updated_at = now()
          where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
        `;
        await this.writeStateEvent(transaction, input, "running");
        await updateBatchStatus(transaction, input.batchId);
      }
      return Boolean(rows[0]);
    });
  }

  async resetForRetry(
    input: GenerationWorkflowInput,
    errorCode: string,
    message: string,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      await transaction`
        update generation_attempts
        set status = 'claimed', submitted_at = null, error_code = ${errorCode}, error_message = ${message}, updated_at = now()
        where id = ${input.attemptId} and status = 'submitting' and executor_claim_id = ${executorClaimId}
      `;
    });
  }

  async markAccepted(
    input: GenerationWorkflowInput,
    providerTaskId: string,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'accepted', provider_task_id = ${providerTaskId}, updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status = 'submitting'
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!rows[0]) return;
      const jobs = await transaction<{ status: string }[]>`
        update generation_jobs
        set status = case when status = 'cancel_requested' then status else 'waiting_provider'::job_status end,
            version = version + 1, updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
        returning status
      `;
      await this.writeStateEvent(
        transaction,
        input,
        jobs[0]?.status ?? "waiting_provider",
      );
      await updateBatchStatus(transaction, input.batchId);
    });
  }

  async markMaterializing(
    input: GenerationWorkflowInput,
    mediaUrl: URL,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'materializing', evidence_json = ${JSON.stringify({ mediaUrls: [mediaUrl.toString()] })}::jsonb, updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status in ('submitting', 'accepted')
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!rows[0]) return;
      const jobs = await transaction<{ status: string }[]>`
        update generation_jobs
        set status = case when status = 'cancel_requested' then status else 'materializing'::job_status end,
            version = version + 1, updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
          and status in ('running', 'waiting_provider', 'cancel_requested')
        returning status
      `;
      if (!jobs[0])
        throw new Error("Generation job cannot enter materializing state");
      await this.writeStateEvent(transaction, input, jobs[0].status);
      await updateBatchStatus(transaction, input.batchId);
    });
  }

  async markMaterialized(
    input: GenerationWorkflowInput,
    asset: MaterializedAsset,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const attempts = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'materializing', evidence_json = ${JSON.stringify({
          materializedAsset: {
            objectKey: asset.objectKey,
            mime: asset.mime,
            bytes: asset.bytes.toString(),
            sha256: asset.sha256,
            kind: asset.kind,
          },
        })}::jsonb, updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status in ('submitting', 'accepted', 'materializing')
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!attempts[0]) return;
      const jobs = await transaction<{ status: string }[]>`
        update generation_jobs
        set status = 'materializing', version = version + 1, updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
          and status in ('running', 'waiting_provider')
        returning status
      `;
      if (jobs[0]) {
        await this.writeStateEvent(transaction, input, jobs[0].status);
        await updateBatchStatus(transaction, input.batchId);
        return;
      }
      const currentJobs = await transaction<{ status: string }[]>`
        select status from generation_jobs
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
      `;
      if (
        !currentJobs[0] ||
        !["materializing", "cancel_requested"].includes(currentJobs[0].status)
      ) {
        throw new Error("Generation job cannot record materialized evidence");
      }
    });
  }

  async markUnknown(
    input: GenerationWorkflowInput,
    message: string,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'outcome_unknown', outcome_unknown_at = coalesce(outcome_unknown_at, now()),
            release_after = coalesce(release_after, coalesce(outcome_unknown_at, now()) + interval '24 hours'),
            reconcile_after = least(
              coalesce(release_after, coalesce(outcome_unknown_at, now()) + interval '24 hours'),
              now() + interval '1 hour'
            ),
            error_code = 'provider_outcome_unknown', error_message = ${message},
            executor_claim_id = null, executor_run_id = null, updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId}
          and attempt.status in ('claimed', 'submitting', 'accepted', 'materializing')
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!rows[0]) return;
      await transaction`
        update generation_jobs set status = 'outcome_unknown', version = version + 1, updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
      `;
      await this.writeStateEvent(
        transaction,
        input,
        "outcome_unknown",
        "provider_outcome_unknown",
        message,
      );
      await updateBatchStatus(transaction, input.batchId);
    });
  }

  async isCancelRequested(
    input: GenerationWorkflowInput,
    executorClaimId: string,
  ): Promise<boolean> {
    const rows = await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      return transaction<{ requested: boolean }[]>`
        select (job.status = 'cancel_requested') as requested
        from generation_jobs job
        join generation_attempts attempt on attempt.workspace_id = job.workspace_id and attempt.id = job.current_attempt_id
        where job.id = ${input.jobId} and attempt.id = ${input.attemptId}
          and attempt.executor_claim_id = ${executorClaimId}
      `;
    });
    return rows[0]?.requested ?? false;
  }

  async convergeFailure(
    input: GenerationWorkflowInput,
    message: string,
    executorClaimId: string,
    dispatchToken: string,
  ): Promise<void> {
    const nextDispatchToken = this.createId();
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<
        { status: string; executor_claim_id: string | null; executor_dispatch_token: string }[]
      >`
        select attempt.status, attempt.executor_claim_id,
               attempt.executor_dispatch_token::text as executor_dispatch_token
        from generation_attempts attempt
        join generation_jobs job on job.workspace_id = attempt.workspace_id and job.id = attempt.job_id
        where attempt.id = ${input.attemptId} and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        for update of attempt, job
      `;
      const status = rows[0]?.status;
      if (
        !status ||
        ["succeeded", "failed", "canceled", "outcome_unknown"].includes(status)
      )
        return;
      if (
        rows[0]?.executor_dispatch_token !== dispatchToken ||
        (rows[0]?.executor_claim_id &&
          rows[0].executor_claim_id !== executorClaimId)
      )
        return;
      if (["created", "claimed"].includes(status)) {
        const changed = await transaction<{ id: string }[]>`
          update generation_attempts set status = 'failed', completed_at = now(), error_code = 'worker_retries_exhausted',
            error_message = ${message.slice(0, 500)}, executor_claim_id = null, executor_run_id = null, updated_at = now()
          where id = ${input.attemptId} and executor_dispatch_token = ${dispatchToken}::uuid
            and (executor_claim_id is null or executor_claim_id = ${executorClaimId})
          returning id
        `;
        if (!changed[0]) return;
        await transaction`select app.release_reservation(${input.attemptId}, ${this.createId()}, 'worker_retries_exhausted_before_submit')`;
        await transaction`
          update generation_jobs set status = 'failed', version = version + 1, terminal_at = now(), updated_at = now()
          where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
        `;
        await this.writeStateEvent(
          transaction,
          input,
          "failed",
          "worker_retries_exhausted",
          message.slice(0, 500),
        );
      } else if (status === "submitting") {
        const changed = await transaction<{ id: string }[]>`
          update generation_attempts
          set status = 'outcome_unknown', outcome_unknown_at = coalesce(outcome_unknown_at, now()),
              release_after = coalesce(release_after, coalesce(outcome_unknown_at, now()) + interval '24 hours'),
              reconcile_after = least(coalesce(release_after, coalesce(outcome_unknown_at, now()) + interval '24 hours'), now() + interval '1 hour'),
              error_code = 'worker_retries_exhausted', error_message = ${message.slice(0, 500)},
              executor_claim_id = null, executor_run_id = null, updated_at = now()
          where id = ${input.attemptId} and executor_dispatch_token = ${dispatchToken}::uuid
            and (executor_claim_id is null or executor_claim_id = ${executorClaimId})
          returning id
        `;
        if (!changed[0]) return;
        await transaction`
          update outbox_events
          set status = 'sent', sent_at = coalesce(sent_at, now()),
              last_error = 'superseded by a newer recovery dispatch generation',
              locked_by = null, locked_at = null, updated_at = now()
          where workspace_id = ${input.workspaceId} and aggregate_id = ${input.jobId}
            and topic = 'generation.job.requested' and status in ('pending', 'sending')
            and payload->>'attemptId' = ${input.attemptId}
            and dispatch_started_token = ${dispatchToken}::uuid
        `;
        await transaction`
          update generation_jobs set status = 'outcome_unknown', version = version + 1, updated_at = now()
          where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
        `;
        await this.writeStateEvent(
          transaction,
          input,
          "outcome_unknown",
          "worker_retries_exhausted",
          message.slice(0, 500),
        );
      } else {
        const changed = await transaction<{ id: string }[]>`
          update generation_attempts
          set executor_claim_id = null, executor_run_id = null,
              executor_dispatch_token = ${nextDispatchToken}::uuid,
              error_code = 'worker_recovery_scheduled', error_message = ${message.slice(0, 500)}, updated_at = now()
          where id = ${input.attemptId} and status in ('accepted', 'materializing')
            and executor_dispatch_token = ${dispatchToken}::uuid
            and (executor_claim_id is null or executor_claim_id = ${executorClaimId})
          returning id
        `;
        if (!changed[0]) return;
        await transaction`
          update outbox_events
          set status = 'sent', sent_at = coalesce(sent_at, now()),
              last_error = 'superseded by a newer recovery dispatch generation',
              locked_by = null, locked_at = null, updated_at = now()
          where workspace_id = ${input.workspaceId} and aggregate_id = ${input.jobId}
            and topic = 'generation.job.requested' and status in ('pending', 'sending')
            and payload->>'attemptId' = ${input.attemptId}
            and dispatch_started_token = ${dispatchToken}::uuid
        `;
        await transaction`
          insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
          values (
            ${this.createId()}, ${input.workspaceId}, 'generation.job.requested', ${input.jobId},
            ${`generation.job.recovery:${input.attemptId}`}, ${JSON.stringify(input)}::jsonb
          ) on conflict (dedupe_key) do update
            set status = 'pending', attempts = 0, available_at = now() + interval '30 seconds', dispatch_started_token = null,
                last_error = null, locked_by = null, locked_at = null, sent_at = null, updated_at = now()
        `;
        await transaction`
          insert into audit_logs (id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id)
          values (${this.createId()}, ${input.workspaceId}, 'system', 'generation.recovery_scheduled', 'attempt', ${input.attemptId},
                  ${message.slice(0, 500)}, ${`generation-recovery:${input.attemptId}:${this.createId()}`})
        `;
      }
      await updateBatchStatus(transaction, input.batchId);
    });
  }

  async confirmCanceled(
    input: GenerationWorkflowInput,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'canceled', completed_at = now(), updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status in ('claimed', 'submitting', 'accepted', 'materializing')
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!rows[0]) return;
      await transaction`select app.release_reservation(${input.attemptId}, ${this.createId()}, 'provider_cancel_confirmed')`;
      await transaction`
        update generation_jobs
        set status = 'canceled', version = version + 1, terminal_at = now(), updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId}
      `;
      await this.writeStateEvent(
        transaction,
        input,
        "canceled",
        "provider_cancel_confirmed",
        "Provider confirmed cancellation",
      );
      await updateBatchStatus(transaction, input.batchId);
    });
  }

  async fail(
    input: GenerationWorkflowInput,
    errorCode: string,
    message: string,
    executorClaimId: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const rows = await transaction<{ id: string }[]>`
        update generation_attempts attempt
        set status = 'failed', error_code = ${errorCode}, error_message = ${message}, completed_at = now(), updated_at = now()
        from generation_jobs job
        where attempt.id = ${input.attemptId} and attempt.status in ('claimed', 'submitting', 'accepted', 'materializing')
          and attempt.executor_claim_id = ${executorClaimId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        returning attempt.id
      `;
      if (!rows[0]) return;
      await transaction`select app.release_reservation(${input.attemptId}, ${this.createId()}, 'attempt_failed')`;
      await transaction`
        update generation_jobs
        set status = 'failed', version = version + 1, terminal_at = now(), updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId} and status <> 'succeeded'
      `;
      await this.writeStateEvent(
        transaction,
        input,
        "failed",
        errorCode,
        message,
      );
      await updateBatchStatus(transaction, input.batchId);
    });
  }

  async complete(
    input: GenerationWorkflowInput,
    asset: MaterializedAsset,
    executorClaimId: string,
  ): Promise<string> {
    return this.sql.begin(async (transaction) => {
      await serviceContext(transaction);
      const current = await transaction<
        {
          status: string;
          executor_claim_id: string | null;
          job_status: string;
          output_asset_id: string | null;
        }[]
      >`
        select attempt.status, attempt.executor_claim_id, job.status as job_status, job.output_asset_id
        from generation_attempts attempt
        join generation_jobs job on job.workspace_id = attempt.workspace_id and job.id = attempt.job_id
        where attempt.id = ${input.attemptId} and attempt.workspace_id = ${input.workspaceId}
          and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
        for update of attempt, job
      `;
      if (!current[0])
        throw new Error("Generation attempt is no longer current");
      if (current[0].status === "succeeded" && current[0].output_asset_id)
        return current[0].output_asset_id;
      if (current[0].executor_claim_id !== executorClaimId)
        throw new Error("Generation execution claim is no longer current");
      if (
        current[0].status !== "materializing" ||
        !["materializing", "cancel_requested"].includes(current[0].job_status)
      ) {
        throw new Error(
          "Only a materializing generation attempt can be completed",
        );
      }
      const assets = await transaction<{ id: string }[]>`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values (
          ${this.createId()}, ${input.workspaceId}, ${asset.kind}, 'ready', ${asset.objectKey},
          ${asset.mime}, ${asset.bytes.toString()}::bigint, ${asset.sha256}
        ) on conflict (object_key) do update
          set status = 'ready', mime = excluded.mime, bytes = excluded.bytes,
              sha256 = excluded.sha256, updated_at = now()
        returning id
      `;
      const assetId = assets[0]?.id;
      if (!assetId) throw new Error("Asset upsert returned no row");
      const attempts = await transaction<{ id: string }[]>`
        update generation_attempts
        set status = 'succeeded', completed_at = now(), error_code = null, error_message = null, updated_at = now()
        where id = ${input.attemptId} and status = 'materializing' and executor_claim_id = ${executorClaimId}
        returning id
      `;
      const jobs = await transaction<{ id: string }[]>`
        update generation_jobs
        set status = 'succeeded', output_asset_id = ${assetId}, version = version + 1,
            terminal_at = now(), updated_at = now()
        where id = ${input.jobId} and current_attempt_id = ${input.attemptId} and status in ('materializing', 'cancel_requested')
        returning id
      `;
      if (!attempts[0] || !jobs[0])
        throw new Error("Generation state changed before completion");
      await transaction`select app.settle_reservation(${input.attemptId}, ${this.createId()})`;
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
        ) select
          ${input.workspaceId}, 'job', ${input.jobId}, ${input.projectId}, ${input.batchId}, ${input.jobId}, ${input.attemptId},
          'generation.job.asset_ready',
          jsonb_build_object('status', 'succeeded', 'assetId', ${assetId}::text,
                             'attemptNo', attempt.attempt_no, 'jobVersion', job.version)
        from generation_attempts attempt join generation_jobs job on job.id = attempt.job_id
        where attempt.id = ${input.attemptId}
      `;
      await updateBatchStatus(transaction, input.batchId);
      return assetId;
    });
  }

  private async writeStateEvent(
    transaction: TransactionSql,
    input: GenerationWorkflowInput,
    status: string,
    errorCode?: string,
    message?: string,
  ): Promise<void> {
    await transaction`
      insert into generation_job_events (
        workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
      ) select
        ${input.workspaceId}, 'job', ${input.jobId}, ${input.projectId}, ${input.batchId}, ${input.jobId}, ${input.attemptId},
        'generation.job.state_changed',
        jsonb_strip_nulls(jsonb_build_object(
          'status', ${status}, 'errorCode', ${errorCode ?? null}, 'errorMessage', ${message ?? null},
          'attemptNo', attempt.attempt_no, 'jobVersion', job.version
        ))
      from generation_attempts attempt join generation_jobs job on job.id = attempt.job_id
      where attempt.id = ${input.attemptId}
    `;
  }
}
