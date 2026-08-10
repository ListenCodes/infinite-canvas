import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";

import postgres from "postgres";
import { generationWorkflowInputSchema } from "@infinite-canvas/contracts";
import { AdapterRegistry } from "@infinite-canvas/provider-adapters";

import { loadWorkerConfig } from "./config.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { GenerationExecutor } from "./executor.js";
import { UnknownOutcomeReconciler } from "./reconciler.js";
import { GenerationRepository } from "./repository.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;

function runtimeUrl(input: string): string {
  const parsed = new URL(input);
  parsed.username = "infinite_canvas_worker_test";
  parsed.password = "integration-worker-password-67890";
  return parsed.toString();
}

function encrypt(key: Buffer, nonce: Buffer, value: Buffer): string {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

test(
  "dispatcher outage and concurrent recovery trigger each pending attempt once",
  { skip: !adminUrl },
  async () => {
    assert.ok(adminUrl);
    const sql = postgres(runtimeUrl(adminUrl), { max: 6, prepare: false });
    const workspaceId = "00000000-0000-4000-8000-00000000c101";
    const config = loadWorkerConfig({
      NODE_ENV: "test",
      BUSINESS_DATABASE_URL: runtimeUrl(adminUrl),
      HATCHET_MODE: "cloud",
      HATCHET_CLIENT_TOKEN: "integration-token",
      OUTBOX_BATCH_SIZE: "1",
      CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      S3_REGION: "test",
      S3_ENDPOINT: "https://storage.example",
      S3_BUCKET: "test",
      S3_ACCESS_KEY_ID: "test-access",
      S3_SECRET_ACCESS_KEY: "test-secret",
    });
    let failedRunLookups = 1;
    let triggerCalls = 0;
    const acceptedAttempts = new Set<string>();
    const acceptedTokens = new Map<string, Set<string>>();
    const hatchet = {
      async runNoWait(_workflow: string, input: { attemptId: string; dispatchToken: string }) {
        triggerCalls += 1;
        acceptedAttempts.add(input.attemptId);
        const tokens = acceptedTokens.get(input.attemptId) ?? new Set<string>();
        tokens.add(input.dispatchToken);
        acceptedTokens.set(input.attemptId, tokens);
        return {
          async getWorkflowRunId() {
            if (failedRunLookups > 0) {
              failedRunLookups -= 1;
              throw new Error("simulated accepted workflow run-id lookup outage");
            }
            return `run:${input.attemptId}`;
          },
        };
      },
      runs: { async cancel() {} },
    };

    try {
      const before = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const outbox = await transaction<{ id: string }[]>`
        select id from outbox_events where workspace_id = ${workspaceId} and status = 'pending'
        order by created_at limit 1
      `;
        assert.ok(outbox[0]);
        await transaction`
        update outbox_events set attempts = 9, created_at = now() - interval '31 minutes', available_at = now() - interval '1 second'
        where id = ${outbox[0]!.id}
      `;
        return transaction<{ ledger: number }[]>`
        select count(*)::int as ledger from wallet_entries where workspace_id = ${workspaceId}
      `;
      });

      const outageDispatcher = new OutboxDispatcher(
        sql,
        hatchet as never,
        config,
        "outage-dispatcher",
      );
      assert.equal(await outageDispatcher.dispatchOnce(), 1);
      const afterFailure = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ pending: number; dead: number; ledger: number }[]>`
        select
          (select count(*)::int from outbox_events where workspace_id = ${workspaceId} and status = 'pending') as pending,
          (select count(*)::int from outbox_events where workspace_id = ${workspaceId} and status = 'dead') as dead,
          (select count(*)::int from wallet_entries where workspace_id = ${workspaceId}) as ledger
      `;
      });
      assert.equal(afterFailure[0]!.dead, 0);
      assert.equal(afterFailure[0]!.ledger, before[0]!.ledger);
      assert.ok(afterFailure[0]!.pending > 0);

      const ambiguousOutbox = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<{ id: string; payload: unknown; dispatch_started_token: string }[]>`
          select id, payload, dispatch_started_token::text
          from outbox_events
          where workspace_id = ${workspaceId} and status = 'pending' and dispatch_started_token is not null
          order by created_at limit 1
        `;
        assert.ok(rows[0]?.dispatch_started_token);
        await transaction`
          update outbox_events set payload = '{}'::jsonb, available_at = now()
          where id = ${rows[0]!.id}
        `;
        return rows[0]!;
      });
      assert.equal(await outageDispatcher.dispatchOnce(), 1);
      const afterPreflightFailure = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<{ status: string; marker: string; ledger: number }[]>`
          select status::text, dispatch_started_token::text as marker,
            (select count(*)::int from wallet_entries where workspace_id = ${workspaceId}) as ledger
          from outbox_events where id = ${ambiguousOutbox.id}
        `;
        await transaction`
          update outbox_events set payload = ${JSON.stringify(ambiguousOutbox.payload)}::jsonb, available_at = now()
          where id = ${ambiguousOutbox.id}
        `;
        return rows[0]!;
      });
      assert.deepEqual(afterPreflightFailure, {
        status: "pending",
        marker: ambiguousOutbox.dispatch_started_token,
        ledger: before[0]!.ledger,
      });

      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update outbox_events set available_at = now() where workspace_id = ${workspaceId} and status = 'pending'`;
      });
      const recoveryConfig = { ...config, OUTBOX_BATCH_SIZE: 50 };
      const first = new OutboxDispatcher(
        sql,
        hatchet as never,
        recoveryConfig,
        "recovery-a",
      );
      const second = new OutboxDispatcher(
        sql,
        hatchet as never,
        recoveryConfig,
        "recovery-b",
      );
      await Promise.all([first.dispatchOnce(), second.dispatchOnce()]);

      const recovered = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            pending: number;
            sent: number;
            attempts: number;
            runs: number;
            ledger: number;
          }[]
        >`
        select
          (select count(*)::int from outbox_events where workspace_id = ${workspaceId} and status = 'pending') as pending,
          (select count(*)::int from outbox_events where workspace_id = ${workspaceId} and status = 'sent') as sent,
          (select count(*)::int from generation_attempts where workspace_id = ${workspaceId}) as attempts,
          (select count(*)::int from generation_attempts where workspace_id = ${workspaceId} and executor_run_id is not null) as runs,
          (select count(*)::int from wallet_entries where workspace_id = ${workspaceId}) as ledger
      `;
      });
      assert.equal(recovered[0]!.pending, 0);
      assert.equal(recovered[0]!.sent, recovered[0]!.attempts);
      assert.equal(recovered[0]!.runs, recovered[0]!.attempts);
      assert.equal(acceptedAttempts.size, recovered[0]!.attempts);
      assert.equal(recovered[0]!.ledger, before[0]!.ledger);
      assert.ok([...acceptedTokens.values()].every((tokens) => tokens.size === 1));

      const callsAfterRecovery = triggerCalls;
      assert.deepEqual(
        await Promise.all([first.dispatchOnce(), second.dispatchOnce()]),
        [0, 0],
      );
      assert.equal(triggerCalls, callsAfterRecovery);

      const staleOutbox = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<
          {
            job_id: string;
            batch_id: string;
            project_id: string;
            channel_id: string;
            capability: "image" | "video";
            current_attempt_id: string;
            stale_attempt_id: string;
            attempt_status: string;
            reservation_status: string;
            ledger_entries: number;
            event_count: number;
          }[]
        >`
          select job.id as job_id, job.batch_id, batch.project_id, current_attempt.channel_id,
                 job.capability, current_attempt.id as current_attempt_id, stale_attempt.id as stale_attempt_id,
                 current_attempt.status::text as attempt_status, reservation.status::text as reservation_status,
                  (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = current_attempt.id) as ledger_entries,
                 (select count(*)::int from generation_job_events where attempt_id = current_attempt.id) as event_count
          from generation_jobs job
          join generation_batches batch on batch.id = job.batch_id
          join generation_attempts current_attempt on current_attempt.id = job.current_attempt_id
          join credit_reservations reservation on reservation.attempt_id = current_attempt.id and reservation.status = 'reserved'
          join generation_attempts stale_attempt on stale_attempt.job_id = job.id and stale_attempt.id <> current_attempt.id
          where job.workspace_id = ${workspaceId}
          order by stale_attempt.attempt_no limit 1
        `;
        const current = rows[0];
        assert.ok(current);
        const outboxId = randomUUID();
        await transaction`
          insert into outbox_events (
            id, workspace_id, topic, aggregate_id, dedupe_key, payload, attempts, available_at, created_at
          ) values (
            ${outboxId}, ${workspaceId}, 'generation.job.requested', ${current.job_id}, ${`integration-stale:${outboxId}`},
            ${JSON.stringify({
              schemaVersion: 1,
              workflowName: "media-generation-v1",
              workspaceId,
              projectId: current.project_id,
              batchId: current.batch_id,
              jobId: current.job_id,
              attemptId: current.stale_attempt_id,
              capability: current.capability,
              channelId: current.channel_id,
            })}::jsonb,
            9, now() - interval '1 second', now() - interval '31 minutes'
          )
        `;
        return { ...current, outbox_id: outboxId };
      });
      assert.equal(await first.dispatchOnce(), 1);
      const staleOutboxResult = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            outbox_status: string;
            attempt_status: string;
            reservation_status: string;
            ledger_entries: number;
            event_count: number;
          }[]
        >`
          select
            (select status::text from outbox_events where id = ${staleOutbox.outbox_id}) as outbox_status,
            (select status::text from generation_attempts where id = ${staleOutbox.current_attempt_id}) as attempt_status,
            (select status::text from credit_reservations where attempt_id = ${staleOutbox.current_attempt_id}) as reservation_status,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${staleOutbox.current_attempt_id}) as ledger_entries,
            (select count(*)::int from generation_job_events where attempt_id = ${staleOutbox.current_attempt_id}) as event_count
        `;
      });
      assert.deepEqual(staleOutboxResult[0], {
        outbox_status: "sent",
        attempt_status: staleOutbox.attempt_status,
        reservation_status: staleOutbox.reservation_status,
        ledger_entries: staleOutbox.ledger_entries,
        event_count: staleOutbox.event_count,
      });

      const unknownCandidate = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<
          {
            attempt_id: string;
            job_id: string;
            batch_id: string;
            project_id: string;
            channel_id: string;
            capability: "image" | "video";
            adapter_type: string;
            adapter_version: number;
            credential_version: number;
            dispatch_token: string;
          }[]
        >`
        select attempt.id as attempt_id, job.id as job_id, job.batch_id, batch.project_id,
               attempt.channel_id, job.capability, attempt.adapter_type, attempt.adapter_version,
               attempt.credential_version, attempt.executor_dispatch_token::text as dispatch_token
        from generation_attempts attempt
        join generation_jobs job on job.id = attempt.job_id and job.current_attempt_id = attempt.id
        join generation_batches batch on batch.id = job.batch_id
        join credit_reservations reservation on reservation.attempt_id = attempt.id and reservation.status = 'reserved'
        where attempt.workspace_id = ${workspaceId} and attempt.status = 'created'
        order by attempt.created_at desc limit 1
        for update of attempt, job, reservation
      `;
        const current = rows[0];
        assert.ok(current);
        const masterKey = Buffer.alloc(32);
        const dataKey = randomBytes(32);
        const nonce = randomBytes(12);
        await transaction`
          update provider_credentials
          set encrypted_data_key = ${encrypt(masterKey, nonce, dataKey)},
              encrypted_secret = ${encrypt(dataKey, nonce, Buffer.from("provider-secret"))},
              nonce = ${nonce.toString("base64")}
          where channel_id = ${current.channel_id} and version = ${current.credential_version}
      `;
        dataKey.fill(0);
        return current;
      });

      let ambiguousProviderSubmits = 0;
      let ambiguousMaterializations = 0;
      const ambiguousRegistry = new AdapterRegistry();
      ambiguousRegistry.register({
        type: unknownCandidate.adapter_type,
        version: unknownCandidate.adapter_version,
        capability: unknownCandidate.capability,
        validate() {},
        async submit() {
          ambiguousProviderSubmits += 1;
          throw new Error("connection reset after paid provider accepted the request");
        },
      });
      const ambiguousRepository = new GenerationRepository(
        sql,
        config,
        ambiguousRegistry,
        { trustedOrigin: () => "https://storage.example" } as never,
        randomUUID,
      );
      const ambiguousExecutor = new GenerationExecutor(ambiguousRepository, {
        async materialize() {
          ambiguousMaterializations += 1;
          throw new Error("outcome-unknown attempt must not materialize");
        },
        async recoverMaterialized() {
          return undefined;
        },
      });
      const ambiguousInput = generationWorkflowInputSchema.parse({
        schemaVersion: 1,
        workflowName: "media-generation-v1",
        workspaceId,
        projectId: unknownCandidate.project_id,
        batchId: unknownCandidate.batch_id,
        jobId: unknownCandidate.job_id,
        attemptId: unknownCandidate.attempt_id,
        capability: unknownCandidate.capability,
        channelId: unknownCandidate.channel_id,
      });
      const ambiguousContext = {
        workflowRunId: "integration-lost-provider-response",
        dispatchToken: unknownCandidate.dispatch_token,
        signal: new AbortController().signal,
      };
      assert.equal((await ambiguousExecutor.execute(ambiguousInput, ambiguousContext)).outcome, "outcome_unknown");
      assert.equal((await ambiguousExecutor.execute(ambiguousInput, ambiguousContext)).outcome, "duplicate");
      assert.equal(ambiguousProviderSubmits, 1);
      assert.equal(ambiguousMaterializations, 0);

      const unknown = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<{
          attempt_id: string;
          job_id: string;
          batch_id: string;
          release_after: Date;
          outcome_unknown_at: Date;
          reconcile_after: Date;
          attempt_status: string;
          job_status: string;
          reservation_status: string;
          financial_transitions: number;
          unknown_events: number;
        }[]>`
          select attempt.id as attempt_id, job.id as job_id, job.batch_id,
                 attempt.release_after, attempt.outcome_unknown_at, attempt.reconcile_after,
                 attempt.status::text as attempt_status, job.status::text as job_status,
                 reservation.status::text as reservation_status,
                 (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = attempt.id and kind in ('settle', 'release', 'release_after_unknown_timeout')) as financial_transitions,
                 (select count(*)::int from generation_job_events where attempt_id = attempt.id and payload->>'status' = 'outcome_unknown') as unknown_events
          from generation_attempts attempt
          join generation_jobs job on job.id = attempt.job_id and job.current_attempt_id = attempt.id
          join credit_reservations reservation on reservation.attempt_id = attempt.id
          where attempt.id = ${unknownCandidate.attempt_id}
        `;
        return rows[0]!;
      });
      assert.equal(unknown.attempt_status, "outcome_unknown");
      assert.equal(unknown.job_status, "outcome_unknown");
      assert.equal(unknown.reservation_status, "reserved");
      assert.equal(unknown.financial_transitions, 0);
      assert.equal(unknown.unknown_events, 1);
      assert.equal(unknown.reconcile_after.getTime() - unknown.outcome_unknown_at.getTime(), 60 * 60 * 1000);
      assert.equal(unknown.release_after.getTime() - unknown.outcome_unknown_at.getTime(), 24 * 60 * 60 * 1000);

      const reconciler = new UnknownOutcomeReconciler(sql, randomUUID);
      const unknownReleaseNow = new Date(unknown.release_after.getTime() + 1_000);
      assert.equal(await reconciler.reconcileOnce(unknownReleaseNow), 1);
      assert.equal(await reconciler.reconcileOnce(unknownReleaseNow), 0);
      const reconciled = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            attempt_status: string;
            job_status: string;
            reservation_status: string;
            risk_entries: number;
            timeout_releases: number;
            release_audits: number;
          }[]
        >`
        select
          (select status::text from generation_attempts where id = ${unknown.attempt_id}) as attempt_status,
          (select status::text from generation_jobs where id = ${unknown.job_id}) as job_status,
          (select status::text from credit_reservations where attempt_id = ${unknown.attempt_id}) as reservation_status,
          (select count(*)::int from platform_risk_entries where attempt_id = ${unknown.attempt_id}) as risk_entries,
          (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${unknown.attempt_id} and kind = 'release_after_unknown_timeout') as timeout_releases,
          (select count(*)::int from audit_logs where target_id = ${unknown.attempt_id} and action = 'outcome_unknown.release') as release_audits
      `;
      });
      assert.deepEqual(reconciled[0], {
        attempt_status: "failed",
        job_status: "failed",
        reservation_status: "released",
        risk_entries: 1,
        timeout_releases: 1,
        release_audits: 1,
      });
      const lateSuccessBefore = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          available: string;
          reserved: string;
          risk_entries: number;
          timeout_releases: number;
          settlements: number;
        }[]>`
          select
            wallet.available::text,
            wallet.reserved::text,
            (select count(*)::int from platform_risk_entries where attempt_id = ${unknown.attempt_id}) as risk_entries,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${unknown.attempt_id} and kind = 'release_after_unknown_timeout') as timeout_releases,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${unknown.attempt_id} and kind = 'settle') as settlements
          from wallet_accounts wallet where wallet.workspace_id = ${workspaceId}
        `;
      });
      let lateProviderQueries = 0;
      const lateSuccessReconciler = new UnknownOutcomeReconciler(
        sql,
        randomUUID,
        60_000,
        async () => {
          lateProviderQueries += 1;
          return true;
        },
      );
      assert.equal(await lateSuccessReconciler.reconcileOnce(new Date(unknownReleaseNow.getTime() + 48 * 60 * 60 * 1000)), 0);
      assert.equal(lateProviderQueries, 0);
      const lateSuccessAfter = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          available: string;
          reserved: string;
          risk_entries: number;
          timeout_releases: number;
          settlements: number;
        }[]>`
          select
            wallet.available::text,
            wallet.reserved::text,
            (select count(*)::int from platform_risk_entries where attempt_id = ${unknown.attempt_id}) as risk_entries,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${unknown.attempt_id} and kind = 'release_after_unknown_timeout') as timeout_releases,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${unknown.attempt_id} and kind = 'settle') as settlements
          from wallet_accounts wallet where wallet.workspace_id = ${workspaceId}
        `;
      });
      assert.deepEqual(lateSuccessAfter, lateSuccessBefore);

      const materializing = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<
          {
            attempt_id: string;
            job_id: string;
            batch_id: string;
            project_id: string;
            channel_id: string;
            capability: "image" | "video";
            dispatch_token: string;
          }[]
        >`
        select attempt.id as attempt_id, job.id as job_id, job.batch_id, batch.project_id,
               attempt.channel_id, job.capability,
               attempt.executor_dispatch_token::text as dispatch_token
        from generation_attempts attempt
        join generation_jobs job on job.id = attempt.job_id and job.current_attempt_id = attempt.id
        join generation_batches batch on batch.id = job.batch_id
        join credit_reservations reservation on reservation.attempt_id = attempt.id and reservation.status = 'reserved'
        where attempt.workspace_id = ${workspaceId} and attempt.id <> ${unknown.attempt_id}
        order by attempt.created_at desc limit 1
        for update of attempt, job, reservation
      `;
        const current = rows[0];
        assert.ok(current);
        await transaction`update generation_attempts set status = 'accepted', executor_claim_id = 'claim-old' where id = ${current.attempt_id}`;
        await transaction`update generation_jobs set status = 'waiting_provider', version = version + 1 where id = ${current.job_id}`;
        await transaction`
          update outbox_events
          set status = 'sent', sent_at = coalesce(sent_at, now()), dispatch_started_token = null
          where aggregate_id = ${current.job_id} and topic = 'generation.job.requested'
            and payload->>'attemptId' = ${current.attempt_id}
        `;
        const oldPayload = {
          schemaVersion: 1,
          workflowName: "media-generation-v1",
          workspaceId,
          projectId: current.project_id,
          batchId: current.batch_id,
          jobId: current.job_id,
          attemptId: current.attempt_id,
          capability: current.capability,
          channelId: current.channel_id,
        };
        const oldOutbox = await transaction<{ id: string }[]>`
          insert into outbox_events (
            id, workspace_id, topic, aggregate_id, dedupe_key, payload, status, dispatch_started_token
          ) values (
            ${randomUUID()}, ${workspaceId}, 'generation.job.requested', ${current.job_id},
            ${`generation.job.stale-marker:${current.attempt_id}`}, ${JSON.stringify(oldPayload)}::jsonb,
            'pending', ${current.dispatch_token}::uuid
          )
          returning id
        `;
        assert.ok(oldOutbox[0]);
        return current;
      });
      const workflowInput = generationWorkflowInputSchema.parse({
        schemaVersion: 1,
        workflowName: "media-generation-v1",
        workspaceId,
        projectId: materializing.project_id,
        batchId: materializing.batch_id,
        jobId: materializing.job_id,
        attemptId: materializing.attempt_id,
        capability: materializing.capability,
        channelId: materializing.channel_id,
      });
      const repository = new GenerationRepository(
        sql,
        config,
        new AdapterRegistry(),
        {} as never,
        randomUUID,
      );
      const materializedAsset = {
        objectKey: `${workspaceId}/generated/${materializing.attempt_id}.png`,
        mime: "image/png",
        bytes: 10n,
        sha256: "b".repeat(64),
        kind: "image" as const,
      };
      await repository.convergeFailure(
        workflowInput,
        "old execution failed",
        "claim-old",
        materializing.dispatch_token,
      );
      const supersededOldOutbox = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ active: number; superseded: number }[]>`
          select
            count(*) filter (where status in ('pending', 'sending') and dispatch_started_token = ${materializing.dispatch_token}::uuid)::int as active,
            count(*) filter (where status = 'sent' and dispatch_started_token = ${materializing.dispatch_token}::uuid
              and last_error = 'superseded by a newer recovery dispatch generation')::int as superseded
          from outbox_events
          where aggregate_id = ${materializing.job_id} and topic = 'generation.job.requested'
            and payload->>'attemptId' = ${materializing.attempt_id}
        `;
      });
      assert.deepEqual(supersededOldOutbox[0], { active: 0, superseded: 1 });
      const preExecutionDispatchToken = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update outbox_events set status = 'sent', sent_at = now()
          where dedupe_key = ${`generation.job.recovery:${materializing.attempt_id}`}
        `;
        const tokens = await transaction<{ dispatch_token: string }[]>`
          select executor_dispatch_token::text as dispatch_token
          from generation_attempts where id = ${materializing.attempt_id}
        `;
        assert.ok(tokens[0]);
        return tokens[0].dispatch_token;
      });
      await repository.convergeFailure(
        workflowInput,
        "recovery failed before its first execution step",
        "claim-pre-execution",
        preExecutionDispatchToken,
      );
      const preExecutionRecovery = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ claim: string | null; run: string | null; dispatch_token: string; outbox_status: string }[]>`
          select attempt.executor_claim_id as claim, attempt.executor_run_id as run,
                 attempt.executor_dispatch_token::text as dispatch_token,
                 outbox.status::text as outbox_status
          from generation_attempts attempt
          join outbox_events outbox
            on outbox.dedupe_key = ${`generation.job.recovery:${materializing.attempt_id}`}
          where attempt.id = ${materializing.attempt_id}
        `;
      });
      assert.deepEqual({
        claim: preExecutionRecovery[0]?.claim,
        run: preExecutionRecovery[0]?.run,
        outbox_status: preExecutionRecovery[0]?.outbox_status,
      }, {
        claim: null,
        run: null,
        outbox_status: "pending",
      });
      assert.match(preExecutionRecovery[0]!.dispatch_token, /^[a-f0-9-]{36}$/);
      assert.notEqual(preExecutionRecovery[0]?.dispatch_token, preExecutionDispatchToken);
      const staleDispatcherWrite = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ id: string }[]>`
          update generation_attempts set executor_run_id = 'stale-run'
          where id = ${materializing.attempt_id}
            and executor_dispatch_token = ${preExecutionDispatchToken}::uuid
          returning id
        `;
      });
      assert.equal(staleDispatcherWrite.length, 0);
      await repository.convergeFailure(
        workflowInput,
        "late callback from the prior dispatch generation",
        "claim-pre-execution",
        preExecutionDispatchToken,
      );
      assert.equal(
        await repository.claim(workflowInput, "claim-new", preExecutionRecovery[0]!.dispatch_token),
        "claimed",
      );
      const beforeStaleExecutor = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            attempt_status: string;
            job_status: string;
            reservation_status: string;
            ledger_entries: number;
            event_count: number;
          }[]
        >`
          select attempt.status::text as attempt_status, job.status::text as job_status,
                 reservation.status::text as reservation_status,
                 (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = attempt.id) as ledger_entries,
                 (select count(*)::int from generation_job_events where attempt_id = attempt.id) as event_count
          from generation_attempts attempt
          join generation_jobs job on job.id = attempt.job_id
          join credit_reservations reservation on reservation.attempt_id = attempt.id
          where attempt.id = ${materializing.attempt_id}
        `;
      });
      await repository.fail(
        workflowInput,
        "stale_failure",
        "late failure from old execution",
        "claim-old",
      );
      await repository.confirmCanceled(workflowInput, "claim-old");
      const afterStaleExecutor = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            attempt_status: string;
            job_status: string;
            reservation_status: string;
            ledger_entries: number;
            event_count: number;
          }[]
        >`
          select attempt.status::text as attempt_status, job.status::text as job_status,
                 reservation.status::text as reservation_status,
                 (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = attempt.id) as ledger_entries,
                 (select count(*)::int from generation_job_events where attempt_id = attempt.id) as event_count
          from generation_attempts attempt
          join generation_jobs job on job.id = attempt.job_id
          join credit_reservations reservation on reservation.attempt_id = attempt.id
          where attempt.id = ${materializing.attempt_id}
        `;
      });
      assert.deepEqual(afterStaleExecutor[0], beforeStaleExecutor[0]);
      await assert.rejects(
        repository.complete(workflowInput, materializedAsset, "claim-new"),
        /materializing/i,
      );
      await repository.markMaterialized(
        workflowInput,
        materializedAsset,
        "claim-new",
      );
      const materializingState = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ attempt_status: string; job_status: string }[]>`
        select attempt.status::text as attempt_status, job.status::text as job_status
        from generation_attempts attempt join generation_jobs job on job.id = attempt.job_id
        where attempt.id = ${materializing.attempt_id}
      `;
      });
      assert.deepEqual(materializingState[0], {
        attempt_status: "materializing",
        job_status: "materializing",
      });
      const firstAssetId = await repository.complete(
        workflowInput,
        materializedAsset,
        "claim-new",
      );
      const replayedAssetId = await repository.complete(
        workflowInput,
        materializedAsset,
        "claim-new",
      );
      assert.equal(replayedAssetId, firstAssetId);
      const completion = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            assets: number;
            settlements: number;
            reservation_status: string;
            attempt_status: string;
          }[]
        >`
        select
          (select count(*)::int from assets where object_key = ${materializedAsset.objectKey}) as assets,
          (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${materializing.attempt_id} and kind = 'settle') as settlements,
          (select status::text from credit_reservations where attempt_id = ${materializing.attempt_id}) as reservation_status,
          (select status::text from generation_attempts where id = ${materializing.attempt_id}) as attempt_status
      `;
      });
      assert.deepEqual(completion[0], {
        assets: 1,
        settlements: 1,
        reservation_status: "settled",
        attempt_status: "succeeded",
      });

      const knownProviderUnknown = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<{
          attempt_id: string;
          job_id: string;
          batch_id: string;
          project_id: string;
          channel_id: string;
          credential_version: number;
          capability: "image" | "video";
        }[]>`
          select attempt.id as attempt_id, job.id as job_id, job.batch_id, batch.project_id,
                 attempt.channel_id, attempt.credential_version, job.capability
          from generation_attempts attempt
          join generation_jobs job on job.id = attempt.job_id and job.current_attempt_id = attempt.id
          join generation_batches batch on batch.id = job.batch_id
          join credit_reservations reservation on reservation.attempt_id = attempt.id and reservation.status = 'reserved'
          where attempt.workspace_id = ${workspaceId} and attempt.status in ('created', 'claimed')
          order by attempt.created_at limit 1
          for update of attempt, job, reservation
        `;
        const current = rows[0];
        assert.ok(current);
        const masterKey = Buffer.alloc(32);
        const dataKey = randomBytes(32);
        const nonce = randomBytes(12);
        await transaction`
          update provider_credentials
          set encrypted_data_key = ${encrypt(masterKey, nonce, dataKey)},
              encrypted_secret = ${encrypt(dataKey, nonce, Buffer.from("provider-secret"))},
              nonce = ${nonce.toString("base64")}
          where channel_id = ${current.channel_id} and version = ${current.credential_version}
        `;
        dataKey.fill(0);
        await transaction`
          update generation_attempts
          set status = 'accepted', provider_task_id = 'known-provider-task',
              outcome_unknown_at = null, reconcile_after = null, release_after = null,
              executor_claim_id = 'unknown-source-claim', executor_run_id = 'unknown-source-claim'
          where id = ${current.attempt_id}
        `;
        await transaction`
          update generation_jobs set status = 'waiting_provider', version = version + 1
          where id = ${current.job_id}
        `;
        return current;
      });
      let providerPolls = 0;
      let providerSubmits = 0;
      const reconciliationRegistry = new AdapterRegistry();
      reconciliationRegistry.register({
        type: "grok2api",
        version: 1,
        capability: "image",
        validate() {},
        async submit() {
          providerSubmits += 1;
          return { outcome: "outcome_unknown", message: "must not submit" } as const;
        },
        async poll() {
          providerPolls += 1;
          return {
            status: "succeeded",
            mediaUrls: [new URL("https://media.example/result.png")],
          } as const;
        },
      });
      const reconciliationRepository = new GenerationRepository(
        sql,
        config,
        reconciliationRegistry,
        { trustedOrigin: () => "https://storage.example" } as never,
        randomUUID,
      );
      const knownProviderInput = generationWorkflowInputSchema.parse({
        schemaVersion: 1,
        workflowName: "media-generation-v1",
        workspaceId,
        projectId: knownProviderUnknown.project_id,
        batchId: knownProviderUnknown.batch_id,
        jobId: knownProviderUnknown.job_id,
        attemptId: knownProviderUnknown.attempt_id,
        capability: knownProviderUnknown.capability,
        channelId: knownProviderUnknown.channel_id,
      });
      await reconciliationRepository.markUnknown(
        knownProviderInput,
        "provider query was temporarily unavailable",
        "unknown-source-claim",
      );
      const providerReconciler = new UnknownOutcomeReconciler(
        sql,
        randomUUID,
        60_000,
        (candidate, now) =>
          reconciliationRepository.reconcileUnknownProviderTask(
            candidate,
            now,
          ),
      );
      assert.equal(
        await providerReconciler.reconcileOnce(
          new Date(Date.now() + 60 * 60 * 1000 + 1_000),
        ),
        1,
      );
      assert.equal(providerPolls, 1);
      assert.equal(providerSubmits, 0);
      const recoveredProviderTask = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          attempt_status: string;
          job_status: string;
          reservation_status: string;
          recovery_outbox: number;
        }[]>`
          select
            (select status::text from generation_attempts where id = ${knownProviderUnknown.attempt_id}) as attempt_status,
            (select status::text from generation_jobs where id = ${knownProviderUnknown.job_id}) as job_status,
            (select status::text from credit_reservations where attempt_id = ${knownProviderUnknown.attempt_id}) as reservation_status,
            (select count(*)::int from outbox_events where dedupe_key = ${`generation.job.unknown-recovered:${knownProviderUnknown.attempt_id}`} and status = 'pending') as recovery_outbox
        `;
      });
      assert.deepEqual(recoveredProviderTask[0], {
        attempt_status: "materializing",
        job_status: "materializing",
        reservation_status: "reserved",
        recovery_outbox: 1,
      });
    } finally {
      await sql.end();
    }
  },
);
