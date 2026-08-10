import type postgres from "postgres";

import type { HatchetClient } from "@hatchet-dev/typescript-sdk";
import {
  generationWorkflowInputSchema,
  localDataImportWorkflowInputSchema,
} from "@infinite-canvas/contracts";
import { z } from "zod";

import type { WorkerConfig } from "./config.js";
import {
  dispatchedGenerationWorkflowInputSchema,
  LOCAL_DATA_IMPORT_WORKFLOW_V1,
  MEDIA_GENERATION_WORKFLOW_V1,
} from "./workflow.js";

type Sql = postgres.Sql;

interface OutboxRow {
  id: string;
  workspace_id: string;
  topic: string;
  payload: unknown;
  attempts: number;
  aggregate_id: string;
  created_at: Date;
  dispatch_started_token: string | null;
}

const cancelPayloadSchema = z.object({ jobId: z.uuid(), attemptId: z.uuid() });
const accountAuthPayloadSchema = z.object({ userId: z.uuid() });

export interface AccountAuthSynchronizer {
  setUserDisabled(userId: string, disabled: boolean): Promise<void>;
}

export class OutboxDispatcher {
  #stopped = false;
  #active: Promise<void> | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly hatchet: HatchetClient,
    private readonly config: WorkerConfig,
    private readonly workerId: string,
    private readonly accountAuth: AccountAuthSynchronizer = {
      async setUserDisabled() {
        throw new Error(
          "Account authentication synchronizer is not configured",
        );
      },
    },
  ) {}

  start(): void {
    if (!this.#active) this.#active = this.run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#active;
  }

  async dispatchOnce(): Promise<number> {
    const rows = await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      return transaction<
        OutboxRow[]
      >`select id, workspace_id, topic, payload, attempts, aggregate_id, created_at, dispatch_started_token from app.claim_outbox(${this.workerId}, ${this.config.OUTBOX_BATCH_SIZE})`;
    });
    for (const row of rows) await this.dispatch(row);
    return rows.length;
  }

  private async run(): Promise<void> {
    while (!this.#stopped) {
      const count = await this.dispatchOnce().catch(() => 0);
      if (count === 0)
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.OUTBOX_POLL_MS),
        );
    }
  }

  private async dispatch(row: OutboxRow): Promise<void> {
    let generationDispatchAttempted = false;
    try {
      if (row.topic === "generation.job.requested") {
        const input = generationWorkflowInputSchema.parse(row.payload);
        const dispatch: { dispatch_token: string }[] = await this.sql.begin(async (transaction) => {
          await transaction`select set_config('app.service_role', 'on', true)`;
          const candidates = await transaction<{ dispatch_token: string }[]>`
            select attempt.executor_dispatch_token::text as dispatch_token
            from outbox_events outbox
            join generation_jobs job on job.id = outbox.aggregate_id and job.workspace_id = outbox.workspace_id
            join generation_batches batch on batch.id = job.batch_id and batch.workspace_id = job.workspace_id
            join generation_attempts attempt on attempt.id = job.current_attempt_id and attempt.workspace_id = job.workspace_id
            where outbox.id = ${row.id} and outbox.status = 'sending' and outbox.locked_by = ${this.workerId}
              and attempt.id = ${input.attemptId} and attempt.workspace_id = ${input.workspaceId}
              and attempt.job_id = ${input.jobId} and attempt.channel_id = ${input.channelId}
              and job.id = ${input.jobId} and job.batch_id = ${input.batchId}
              and job.capability = ${input.capability}::generation_capability
              and batch.project_id = ${input.projectId}
              and attempt.status not in ('succeeded', 'failed', 'canceled')
            for update of outbox, attempt, job
          `;
          const candidate = candidates[0];
          if (!candidate) return [] as { dispatch_token: string }[];
          return transaction<{ dispatch_token: string }[]>`
            update outbox_events
            set dispatch_started_token = ${candidate.dispatch_token}::uuid, updated_at = now()
            where id = ${row.id} and status = 'sending' and locked_by = ${this.workerId}
              and (dispatch_started_token is null or dispatch_started_token = ${candidate.dispatch_token}::uuid)
            returning dispatch_started_token::text as dispatch_token
          `;
        });
        if (!dispatch[0]) {
          await this.markSent(row.id);
          return;
        }
        const dispatchedInput = dispatchedGenerationWorkflowInputSchema.parse({
          ...input,
          dispatchToken: dispatch[0].dispatch_token,
        });
        generationDispatchAttempted = true;
        const reference = await this.hatchet.runNoWait(
          MEDIA_GENERATION_WORKFLOW_V1,
          dispatchedInput,
        );
        const workflowRunId = await reference.getWorkflowRunId();
        await this.sql.begin(async (transaction) => {
          await transaction`select set_config('app.service_role', 'on', true)`;
          await transaction`
            update generation_attempts attempt
            set executor_run_id = ${workflowRunId}, updated_at = now()
            from generation_jobs job, generation_batches batch
            where attempt.id = ${input.attemptId}
              and attempt.workspace_id = ${input.workspaceId}
              and attempt.job_id = ${input.jobId}
              and attempt.channel_id = ${input.channelId}
              and job.id = ${input.jobId} and job.current_attempt_id = attempt.id
              and job.batch_id = ${input.batchId}
              and job.capability = ${input.capability}::generation_capability
              and batch.id = job.batch_id and batch.project_id = ${input.projectId}
              and attempt.executor_dispatch_token = ${dispatchedInput.dispatchToken}
              and attempt.status not in ('succeeded', 'failed', 'canceled')
              and (attempt.executor_run_id is null or attempt.executor_run_id = ${workflowRunId})
          `;
          await transaction`
            update outbox_events
            set status = 'sent', sent_at = now(), locked_by = null, locked_at = null, updated_at = now()
            where id = ${row.id} and status = 'sending' and locked_by = ${this.workerId}
          `;
        });
        return;
      }
      if (row.topic === "generation.job.cancel_requested") {
        const input = cancelPayloadSchema.parse(row.payload);
        const attempts = await this.sql.begin(async (transaction) => {
          await transaction`select set_config('app.service_role', 'on', true)`;
          return transaction<{ status: string }[]>`
            select status from generation_attempts
            where id = ${input.attemptId} and job_id = ${input.jobId}
          `;
        });
        if (!attempts[0])
          throw new Error("Cancellation target attempt was not found");
        // The running workflow cooperatively asks the provider to cancel and then
        // converges the business state. Killing it here can strand an accepted task.
        await this.markSent(row.id);
        return;
      }
      if (row.topic === "data.import.requested") {
        const input = localDataImportWorkflowInputSchema.parse(row.payload);
        await this.hatchet.runNoWait(LOCAL_DATA_IMPORT_WORKFLOW_V1, input);
        await this.markSent(row.id);
        return;
      }
      if (row.topic === "account.auth.sync_requested") {
        const input = accountAuthPayloadSchema.parse(row.payload);
        await this.sql.begin(async (transaction) => {
          await transaction`select set_config('app.service_role', 'on', true)`;
          await transaction`select pg_advisory_xact_lock(hashtextextended(${`account-auth:${input.userId}`}, 0))`;
          const profiles = await transaction<
            { status: "active" | "disabled" }[]
          >`
            select status from profiles where user_id = ${input.userId}
          `;
          const profile = profiles[0];
          if (profile)
            await this.accountAuth.setUserDisabled(
              input.userId,
              profile.status === "disabled",
            );
          await transaction`
            update outbox_events
            set status = 'sent', sent_at = now(), locked_by = null, locked_at = null, updated_at = now()
            where id = ${row.id} and status = 'sending' and locked_by = ${this.workerId}
          `;
        });
        return;
      }
      throw new Error(`Unsupported outbox topic: ${row.topic}`);
    } catch (error) {
      const dead =
        row.attempts >= 10 ||
        Date.now() - row.created_at.getTime() >= 30 * 60 * 1000;
      const delaySeconds = Math.min(300, 2 ** Math.min(row.attempts, 8));
      const message =
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "Outbox dispatch failed";
      if (row.topic === "generation.job.requested" && (generationDispatchAttempted || row.dispatch_started_token)) {
        // Once the Hatchet request has crossed the client boundary, a transport or
        // run-id lookup error cannot prove that the workflow was not accepted.
        // Reusing the persisted dispatch token is the only safe retry.
        await this.requeueAcceptanceUnknown(row, message, delaySeconds);
        return;
      }
      if (dead) {
        await this.deadLetter(row, message);
        return;
      }
      await this.sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update outbox_events
          set status = ${dead ? "dead" : "pending"}::outbox_status,
              available_at = now() + (${delaySeconds}::text || ' seconds')::interval,
              last_error = ${message}, locked_by = null, locked_at = null, updated_at = now()
          where id = ${row.id} and locked_by = ${this.workerId}
        `;
      });
    }
  }

  private async requeueAcceptanceUnknown(
    row: OutboxRow,
    message: string,
    delaySeconds: number,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      const requeued = await transaction<{ id: string }[]>`
        update outbox_events
        set status = 'pending', available_at = now() + (${delaySeconds}::text || ' seconds')::interval,
            last_error = ${`Hatchet acceptance unknown: ${message}`}, locked_by = null, locked_at = null, updated_at = now()
        where id = ${row.id} and status = 'sending' and locked_by = ${this.workerId}
        returning id
      `;
      if (!requeued[0]) return;
      if (row.attempts === 10) {
        await transaction`
          insert into audit_logs (id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id)
          values (${crypto.randomUUID()}, ${row.workspace_id}, 'system', 'outbox.dispatch_acceptance_unknown', 'outbox', ${row.id},
                  ${message}, ${`outbox-dispatch-unknown:${row.id}:${row.attempts}`})
        `;
      }
    });
  }

  private async deadLetter(row: OutboxRow, message: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      const claimed = await transaction<{ id: string }[]>`
        update outbox_events set status = 'dead', last_error = ${message}, locked_by = null, locked_at = null, updated_at = now()
        where id = ${row.id} and status = 'sending' and locked_by = ${this.workerId}
        returning id
      `;
      if (!claimed[0]) return;
      if (row.topic === "generation.job.requested") {
        const parsed = generationWorkflowInputSchema.safeParse(row.payload);
        const jobs = !parsed.success
          ? []
          : await transaction<
              {
                workspace_id: string;
                project_id: string;
                batch_id: string;
                attempt_id: string;
                attempt_status: string;
                executor_run_id: string | null;
                attempt_no: number;
                version: number;
              }[]
            >`
          select job.workspace_id, batch.project_id, job.batch_id, attempt.id as attempt_id,
                 attempt.status as attempt_status, attempt.executor_run_id, attempt.attempt_no, job.version
          from generation_jobs job
          join generation_batches batch on batch.id = job.batch_id and batch.workspace_id = job.workspace_id
          join generation_attempts attempt on attempt.id = job.current_attempt_id and attempt.workspace_id = job.workspace_id
          where job.id = ${parsed.data.jobId} and job.id = ${row.aggregate_id}
            and job.workspace_id = ${parsed.data.workspaceId}
            and batch.id = ${parsed.data.batchId} and batch.project_id = ${parsed.data.projectId}
            and job.capability = ${parsed.data.capability}::generation_capability
            and attempt.id = ${parsed.data.attemptId} and attempt.channel_id = ${parsed.data.channelId}
          for update of job, attempt
        `;
        const job = jobs[0];
        let stateChanged = false;
        if (
          job &&
          !["succeeded", "failed", "canceled"].includes(job.attempt_status)
        ) {
          const changed = await transaction<{ id: string }[]>`
            update generation_attempts set status = 'failed', completed_at = now(), error_code = 'dispatch_unavailable',
              error_message = ${message}, updated_at = now()
            where id = ${job.attempt_id} and status = 'created'
              and executor_claim_id is null and executor_run_id is null
            returning id
          `;
          if (changed[0]) {
            await transaction`select app.release_reservation(${job.attempt_id}, ${crypto.randomUUID()}, 'dispatch_dead_before_trigger')`;
            await transaction`
              update generation_jobs set status = 'failed', version = version + 1, terminal_at = now(), updated_at = now()
              where id = ${row.aggregate_id} and current_attempt_id = ${job.attempt_id}
            `;
            stateChanged = true;
          }
        }
        await transaction`
          insert into audit_logs (id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id)
          values (${crypto.randomUUID()}, ${row.workspace_id}, 'system', 'outbox.dead', 'outbox', ${row.id},
                  ${parsed.success ? message : `Invalid workflow payload: ${message}`}, ${`outbox-dead:${row.id}`})
        `;
        if (job && stateChanged)
          await transaction`
          insert into generation_job_events (workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload)
          select ${job.workspace_id}, 'job', ${row.aggregate_id}, ${job.project_id}, ${job.batch_id}, ${row.aggregate_id}, ${job.attempt_id},
                 'generation.job.state_changed', jsonb_build_object(
                   'status', attempt.status, 'errorCode', attempt.error_code,
                   'attemptNo', attempt.attempt_no, 'jobVersion', generation_jobs.version
                 )
          from generation_attempts attempt join generation_jobs on generation_jobs.id = attempt.job_id
          where attempt.id = ${job.attempt_id}
        `;
        if (job && stateChanged)
          await transaction`select app.refresh_generation_batch(${job.batch_id})`;
      } else if (row.topic === "data.import.requested") {
        await transaction`
          update imports set status = 'failed', error_code = 'dispatch_unavailable', error_message = ${message}, updated_at = now()
          where id = ${row.aggregate_id} and status = 'uploaded'
        `;
      }
    });
  }

  private async markSent(id: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        update outbox_events set status = 'sent', sent_at = now(), locked_by = null, locked_at = null, updated_at = now()
        where id = ${id} and locked_by = ${this.workerId}
      `;
    });
  }
}
