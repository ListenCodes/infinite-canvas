import type postgres from "postgres";

type Sql = postgres.Sql;

export interface UnknownRow {
  attempt_id: string;
  workspace_id: string;
  job_id: string;
  batch_id: string;
  project_id: string;
  release_after: Date;
  provider_task_id: string | null;
  channel_id: string;
  capability: "image" | "video";
  capacity_policy_version: number;
  workspace_concurrency_limit: number;
  workspace_rate_limit_per_minute: number;
  channel_concurrency_limit: number;
  channel_rate_limit_per_minute: number;
  executor_dispatch_token: string;
}

export class UnknownOutcomeReconciler {
  #stopped = false;
  #active: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly createId: () => string,
    private readonly intervalMs = 60_000,
    private readonly reconcileKnownTask?: (candidate: UnknownRow, now: Date) => Promise<boolean>,
  ) {}

  start(): void {
    if (!this.#active) this.#active = this.run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#wake?.();
    await this.#active;
  }

  async reconcileOnce(now = new Date()): Promise<number> {
    const candidates = await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      return transaction<UnknownRow[]>`
        select attempt.id as attempt_id, attempt.workspace_id, attempt.job_id,
               job.batch_id, batch.project_id, attempt.release_after, attempt.provider_task_id,
               attempt.channel_id, job.capability, attempt.capacity_policy_version,
               attempt.workspace_concurrency_limit, attempt.workspace_rate_limit_per_minute,
               attempt.channel_concurrency_limit, attempt.channel_rate_limit_per_minute,
               attempt.executor_dispatch_token::text as executor_dispatch_token
        from generation_attempts attempt
        join generation_jobs job on job.workspace_id = attempt.workspace_id and job.id = attempt.job_id
        join generation_batches batch on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        where attempt.status = 'outcome_unknown' and attempt.reconcile_after <= ${now}
        order by attempt.reconcile_after
        limit 100
      `;
    });
    for (const candidate of candidates) await this.reconcile(candidate, now);
    return candidates.length;
  }

  private async run(): Promise<void> {
    while (!this.#stopped) {
      await this.reconcileOnce().catch(() => 0);
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        this.#timer = setTimeout(resolve, this.intervalMs);
      });
      this.#timer = undefined;
      this.#wake = undefined;
    }
  }

  private async reconcile(candidate: UnknownRow, now: Date): Promise<void> {
    if (
      candidate.release_after > now &&
      candidate.provider_task_id &&
      this.reconcileKnownTask &&
      (await this.reconcileKnownTask(candidate, now))
    ) return;
    await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      const locked = await transaction<{ release_after: Date; amount: string }[]>`
        select attempt.release_after, reservation.amount::text
        from generation_attempts attempt
        join credit_reservations reservation on reservation.attempt_id = attempt.id
        where attempt.id = ${candidate.attempt_id} and attempt.status = 'outcome_unknown'
          and attempt.reconcile_after <= ${now}
        for update of attempt, reservation skip locked
      `;
      const current = locked[0];
      if (!current) return;
      if (current.release_after > now) {
        const nextReconcile = new Date(Math.min(current.release_after.getTime(), now.getTime() + 60 * 60 * 1000));
        await transaction`
          update generation_attempts
          set reconcile_after = ${nextReconcile},
              evidence_json = coalesce(evidence_json, '{}'::jsonb) ||
                jsonb_build_object('lastReconciledAt', ${now.toISOString()}::text, 'reconciliation', 'provider_query_unavailable'),
              updated_at = now()
          where id = ${candidate.attempt_id}
        `;
        await transaction`
          insert into audit_logs (
            id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id
          ) values (
            ${this.createId()}, ${candidate.workspace_id}, 'system', 'outcome_unknown.reconcile',
            'attempt', ${candidate.attempt_id}, 'Provider has no authoritative query for the lost submission response',
            ${`reconcile:${candidate.attempt_id}:${now.toISOString()}`}
          )
        `;
        return;
      }

      await transaction`select app.release_reservation(${candidate.attempt_id}, ${this.createId()}, 'outcome_unknown_24h_timeout')`;
      await transaction`
        insert into platform_risk_entries (id, workspace_id, attempt_id, amount, reason, evidence_json)
        values (
          ${this.createId()}, ${candidate.workspace_id}, ${candidate.attempt_id}, ${current.amount}::bigint,
          'Provider acceptance could not be confirmed within 24 hours',
          jsonb_build_object('releasedAt', ${now.toISOString()}::text, 'policy', 'outcome_unknown_24h_release')
        ) on conflict (attempt_id) do nothing
      `;
      await transaction`
        update generation_attempts
        set status = 'failed', completed_at = ${now}, error_code = 'provider_outcome_unknown',
            error_message = 'Outcome was not confirmed within 24 hours; credits were released', updated_at = now()
        where id = ${candidate.attempt_id}
      `;
      await transaction`
        update generation_jobs
        set status = 'failed', version = version + 1, terminal_at = ${now}, updated_at = now()
        where id = ${candidate.job_id} and current_attempt_id = ${candidate.attempt_id}
      `;
      await transaction`
        insert into audit_logs (
          id, workspace_id, actor_type, action, target_type, target_id, reason, correlation_id
        ) values (
          ${this.createId()}, ${candidate.workspace_id}, 'system', 'outcome_unknown.release', 'attempt',
          ${candidate.attempt_id}, '24-hour uncertainty limit reached; user credits released and platform risk recorded',
          ${`unknown-release:${candidate.attempt_id}`}
        )
      `;
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload
        ) select
          ${candidate.workspace_id}, 'job', ${candidate.job_id}, ${candidate.project_id}, ${candidate.batch_id},
          ${candidate.job_id}, ${candidate.attempt_id}, 'generation.job.state_changed',
          jsonb_build_object('status', 'failed', 'errorCode', 'provider_outcome_unknown', 'creditsReleased', true,
                             'attemptNo', attempt.attempt_no, 'jobVersion', job.version)
        from generation_attempts attempt join generation_jobs job on job.id = attempt.job_id
        where attempt.id = ${candidate.attempt_id}
      `;
      await transaction`select app.refresh_generation_batch(${candidate.batch_id})`;
    });
  }
}
