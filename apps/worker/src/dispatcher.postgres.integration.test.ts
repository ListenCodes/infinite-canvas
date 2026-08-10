import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";

import postgres from "postgres";
import { generationWorkflowInputSchema } from "@infinite-canvas/contracts";
import { jsonParameter } from "@infinite-canvas/db";
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

function integrationCapacity(capability: "image" | "video") {
  return {
    policyVersion: 1,
    workspaceConcurrencyLimit: capability === "image" ? 3 : 2,
    workspaceRateLimitPerMinute: capability === "image" ? 30 : 10,
    channelConcurrencyLimit: 3,
    channelRateLimitPerMinute: 60,
  };
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
      const capacityRepository = new GenerationRepository(
        sql,
        config,
        new AdapterRegistry(),
        {} as never,
        randomUUID,
      );
      const capacityFixture = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const rows = await transaction<{
          payload: unknown;
          dispatch_token: string;
          model_config_id: string;
          model_snapshot: unknown;
          price_snapshot: unknown;
          input_snapshot: unknown;
          estimated_credits: string;
          credential_version: number;
          adapter_type: string;
          adapter_version: number;
          provider_idempotency_supported: boolean;
          request_fingerprint: string;
        }[]>`
          select outbox.payload, attempt.executor_dispatch_token::text as dispatch_token,
                 job.model_config_id, job.model_snapshot, job.price_snapshot, job.input_snapshot,
                 job.estimated_credits::text, attempt.credential_version, attempt.adapter_type,
                 attempt.adapter_version, attempt.provider_idempotency_supported,
                 attempt.request_fingerprint
          from outbox_events outbox
          join generation_jobs job on job.id = outbox.aggregate_id
          join generation_attempts attempt on attempt.id = job.current_attempt_id
          where outbox.workspace_id = ${workspaceId} and outbox.topic = 'generation.job.requested'
            and outbox.status = 'pending' and attempt.status = 'created'
          order by outbox.created_at limit 3
        `;
        assert.equal(rows.length, 3);
        const original = rows.map((row) => ({
          input: generationWorkflowInputSchema.parse(row.payload),
          dispatchToken: row.dispatch_token,
        }));
        const template = original[0]!.input;
        const templateRow = rows[0]!;
        const extraJobId = randomUUID();
        const extraAttemptId = randomUUID();
        const extraDispatchToken = randomUUID();
        await transaction`
          insert into generation_jobs (
            id, workspace_id, batch_id, slot_index, capability, model_config_id,
            model_snapshot, price_snapshot, input_snapshot, estimated_credits
          ) values (
            ${extraJobId}, ${template.workspaceId}, ${template.batchId}, 99, ${template.capability},
            ${templateRow.model_config_id}, ${jsonParameter(transaction, templateRow.model_snapshot)},
            ${jsonParameter(transaction, templateRow.price_snapshot)},
            ${jsonParameter(transaction, templateRow.input_snapshot)}, ${templateRow.estimated_credits}::bigint
          )
        `;
        await transaction`
          insert into generation_attempts (
            id, workspace_id, job_id, attempt_no, channel_id, credential_version,
            adapter_type, adapter_version, provider_idempotency_supported, request_fingerprint,
            business_deadline_at, executor_dispatch_token, capacity_policy_version,
            workspace_concurrency_limit, workspace_rate_limit_per_minute,
            channel_concurrency_limit, channel_rate_limit_per_minute
          ) values (
            ${extraAttemptId}, ${template.workspaceId}, ${extraJobId}, 1, ${template.channelId},
            ${templateRow.credential_version}, ${templateRow.adapter_type}, ${templateRow.adapter_version},
            ${templateRow.provider_idempotency_supported}, ${templateRow.request_fingerprint},
            now() + interval '30 minutes', ${extraDispatchToken},
            ${template.capacity.policyVersion}, ${template.capacity.workspaceConcurrencyLimit},
            ${template.capacity.workspaceRateLimitPerMinute}, ${template.capacity.channelConcurrencyLimit + 1},
            ${template.capacity.channelRateLimitPerMinute}
          )
        `;
        await transaction`update generation_jobs set current_attempt_id = ${extraAttemptId} where id = ${extraJobId}`;
        return {
          original,
          extraJobId,
          extraAttemptId,
          extraDispatchToken,
          extraInput: generationWorkflowInputSchema.parse({
            ...template,
            jobId: extraJobId,
            attemptId: extraAttemptId,
            capacity: {
              ...template.capacity,
              channelConcurrencyLimit: template.capacity.channelConcurrencyLimit + 1,
            },
          }),
        };
      });
      const capacityClaims = capacityFixture.original.map((_, index) => `capacity-original-${index}`);
      assert.deepEqual(
        await Promise.all(capacityFixture.original.map(({ input, dispatchToken }, index) =>
          capacityRepository.claim(input, capacityClaims[index]!, dispatchToken))),
        ["claimed", "claimed", "claimed"],
      );
      assert.equal(
        await capacityRepository.claim(
          capacityFixture.extraInput,
          "capacity-extra",
          capacityFixture.extraDispatchToken,
        ),
        "claimed",
      );
      assert.deepEqual(
        await Promise.all(capacityFixture.original.map(({ input, dispatchToken }, index) =>
          capacityRepository.acquireChannelCapacity(input, dispatchToken, capacityClaims[index]!))),
        ["acquired", "acquired", "acquired"],
      );
      assert.deepEqual(
        await Promise.all(capacityFixture.original.map(({ input, dispatchToken }, index) =>
          capacityRepository.consumeProviderRateCapacity(input, dispatchToken, capacityClaims[index]!))),
        ["acquired", "acquired", "acquired"],
      );
      assert.equal(
        await capacityRepository.acquireChannelCapacity(
          capacityFixture.extraInput,
          capacityFixture.extraDispatchToken,
          "capacity-extra",
        ),
        "busy",
      );
      const capacityUsage = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ workspace_used: number; channel_used: number; leases: number }[]>`
          select
            (select used from generation_capacity_rate_windows where workspace_id = ${workspaceId}) as workspace_used,
            (select used from generation_capacity_rate_windows where channel_id = ${capacityFixture.original[0]!.input.channelId}) as channel_used,
            (select count(*)::int from provider_channel_capacity_leases where channel_id = ${capacityFixture.original[0]!.input.channelId}) as leases
        `;
      });
      assert.deepEqual(capacityUsage[0], { workspace_used: 3, channel_used: 3, leases: 3 });
      await Promise.all(capacityFixture.original.slice(1).map(({ input, dispatchToken }) =>
        capacityRepository.releaseChannelCapacity(input, dispatchToken)));
      const replacementDispatchToken = randomUUID();
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update generation_attempts set executor_dispatch_token = ${replacementDispatchToken}
          where id = ${capacityFixture.original[0]!.input.attemptId}
        `;
      });
      await capacityRepository.releaseChannelCapacity(
        capacityFixture.original[0]!.input,
        capacityFixture.original[0]!.dispatchToken,
      );
      const fencedLease = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{ count: number }[]>`
          select count(*)::int as count from provider_channel_capacity_leases
          where holder_id = ${capacityFixture.original[0]!.input.attemptId}
        `;
      });
      assert.equal(fencedLease[0]?.count, 1);
      await capacityRepository.releaseChannelCapacity(
        capacityFixture.original[0]!.input,
        replacementDispatchToken,
      );
      await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`update generation_jobs set current_attempt_id = null where id = ${capacityFixture.extraJobId}`;
        await transaction`delete from generation_attempts where id = ${capacityFixture.extraAttemptId}`;
        await transaction`delete from generation_jobs where id = ${capacityFixture.extraJobId}`;
      });

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
          update outbox_events set payload = ${jsonParameter(transaction, ambiguousOutbox.payload)}, available_at = now()
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
            ${transaction.json({
              schemaVersion: 2,
              workflowName: "media-generation-v2",
              workspaceId,
              projectId: current.project_id,
              batchId: current.batch_id,
              jobId: current.job_id,
              attemptId: current.stale_attempt_id,
              capability: current.capability,
              channelId: current.channel_id,
              capacity: integrationCapacity(current.capability),
            })},
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
        schemaVersion: 2,
        workflowName: "media-generation-v2",
        workspaceId,
        projectId: unknownCandidate.project_id,
        batchId: unknownCandidate.batch_id,
        jobId: unknownCandidate.job_id,
        attemptId: unknownCandidate.attempt_id,
        capability: unknownCandidate.capability,
        channelId: unknownCandidate.channel_id,
        capacity: integrationCapacity(unknownCandidate.capability),
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
          capacity_leases: number;
          lease_covers_release: boolean;
        }[]>`
          select attempt.id as attempt_id, job.id as job_id, job.batch_id,
                 attempt.release_after, attempt.outcome_unknown_at, attempt.reconcile_after,
                 attempt.status::text as attempt_status, job.status::text as job_status,
                 reservation.status::text as reservation_status,
                 (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = attempt.id and kind in ('settle', 'release', 'release_after_unknown_timeout')) as financial_transitions,
                 (select count(*)::int from generation_job_events where attempt_id = attempt.id and payload->>'status' = 'outcome_unknown') as unknown_events,
                 (select count(*)::int from provider_channel_capacity_leases where holder_id = attempt.id) as capacity_leases,
                 (select lease.lease_expires_at >= attempt.release_after + interval '5 minutes'
                  from provider_channel_capacity_leases lease where lease.holder_id = attempt.id) as lease_covers_release
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
      assert.equal(unknown.capacity_leases, 1);
      assert.equal(unknown.lease_covers_release, true);
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
          schemaVersion: 2,
          workflowName: "media-generation-v2",
          workspaceId,
          projectId: current.project_id,
          batchId: current.batch_id,
          jobId: current.job_id,
          attemptId: current.attempt_id,
          capability: current.capability,
          channelId: current.channel_id,
          capacity: integrationCapacity(current.capability),
        };
        const oldOutbox = await transaction<{ id: string }[]>`
          insert into outbox_events (
            id, workspace_id, topic, aggregate_id, dedupe_key, payload, status, dispatch_started_token
          ) values (
            ${randomUUID()}, ${workspaceId}, 'generation.job.requested', ${current.job_id},
            ${`generation.job.stale-marker:${current.attempt_id}`}, ${transaction.json(oldPayload)},
            'pending', ${current.dispatch_token}::uuid
          )
          returning id
        `;
        assert.ok(oldOutbox[0]);
        return current;
      });
      const workflowInput = generationWorkflowInputSchema.parse({
        schemaVersion: 2,
        workflowName: "media-generation-v2",
        workspaceId,
        projectId: materializing.project_id,
        batchId: materializing.batch_id,
        jobId: materializing.job_id,
        attemptId: materializing.attempt_id,
        capability: materializing.capability,
        channelId: materializing.channel_id,
        capacity: integrationCapacity(materializing.capability),
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
          executor_dispatch_token: string;
        }[]>`
          select attempt.id as attempt_id, job.id as job_id, job.batch_id, batch.project_id,
                 attempt.channel_id, attempt.credential_version, job.capability,
                 attempt.executor_dispatch_token::text as executor_dispatch_token
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
      let signalProviderPollStarted!: () => void;
      let releaseProviderPoll!: () => void;
      const providerPollStarted = new Promise<void>((resolve) => {
        signalProviderPollStarted = resolve;
      });
      const providerPollReleased = new Promise<void>((resolve) => {
        releaseProviderPoll = resolve;
      });
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
          signalProviderPollStarted();
          await providerPollReleased;
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
        schemaVersion: 2,
        workflowName: "media-generation-v2",
        workspaceId,
        projectId: knownProviderUnknown.project_id,
        batchId: knownProviderUnknown.batch_id,
        jobId: knownProviderUnknown.job_id,
        attemptId: knownProviderUnknown.attempt_id,
        capability: knownProviderUnknown.capability,
        channelId: knownProviderUnknown.channel_id,
        capacity: integrationCapacity(knownProviderUnknown.capability),
      });
      assert.equal(
        await reconciliationRepository.acquireChannelCapacity(
          knownProviderInput,
          knownProviderUnknown.executor_dispatch_token,
          "unknown-source-claim",
        ),
        "acquired",
      );
      assert.equal(
        await reconciliationRepository.consumeProviderRateCapacity(
          knownProviderInput,
          knownProviderUnknown.executor_dispatch_token,
          "unknown-source-claim",
        ),
        "acquired",
      );
      await reconciliationRepository.markUnknown(
        knownProviderInput,
        "provider query was temporarily unavailable",
        "unknown-source-claim",
      );
      const retainedUnknownLease = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        await transaction`
          update generation_attempts
          set executor_claim_id = 'unknown-reconcile:crashed', updated_at = now() - interval '6 minutes'
          where id = ${knownProviderUnknown.attempt_id}
        `;
        return transaction<{ leases: number; covers_release: boolean; rate_used: number }[]>`
          select
            (select count(*)::int from provider_channel_capacity_leases
             where holder_id = ${knownProviderUnknown.attempt_id}) as leases,
            (select lease.lease_expires_at >= attempt.release_after
             from provider_channel_capacity_leases lease
             join generation_attempts attempt on attempt.id = lease.holder_id
             where attempt.id = ${knownProviderUnknown.attempt_id}) as covers_release,
            (select used from generation_capacity_rate_windows
             where workspace_id = ${workspaceId} and channel_id is null
               and capability = ${knownProviderUnknown.capability}
               and window_started_at = date_trunc('minute', now())) as rate_used
        `;
      });
      assert.equal(retainedUnknownLease[0]?.leases, 1);
      assert.equal(retainedUnknownLease[0]?.covers_release, true);
      const rateBeforeReconcile = retainedUnknownLease[0]!.rate_used;
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
      const reconcileAt = new Date(Date.now() + 60 * 60 * 1000 + 1_000);
      const firstReconcile = providerReconciler.reconcileOnce(reconcileAt);
      await providerPollStarted;
      assert.equal(await providerReconciler.reconcileOnce(reconcileAt), 1);
      releaseProviderPoll();
      assert.equal(await firstReconcile, 1);
      assert.equal(providerPolls, 1);
      assert.equal(providerSubmits, 0);
      const recoveredProviderTask = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          attempt_status: string;
          dispatch_token: string;
          job_status: string;
          reservation_status: string;
          recovery_outbox: number;
          capacity_leases: number;
          rate_used: number;
        }[]>`
          select
            (select status::text from generation_attempts where id = ${knownProviderUnknown.attempt_id}) as attempt_status,
            (select executor_dispatch_token::text from generation_attempts where id = ${knownProviderUnknown.attempt_id}) as dispatch_token,
            (select status::text from generation_jobs where id = ${knownProviderUnknown.job_id}) as job_status,
            (select status::text from credit_reservations where attempt_id = ${knownProviderUnknown.attempt_id}) as reservation_status,
            (select count(*)::int from outbox_events where dedupe_key = ${`generation.job.unknown-recovered:${knownProviderUnknown.attempt_id}`} and status = 'pending') as recovery_outbox,
            (select count(*)::int from provider_channel_capacity_leases
             where holder_id = ${knownProviderUnknown.attempt_id}) as capacity_leases,
            (select used from generation_capacity_rate_windows
             where workspace_id = ${workspaceId} and channel_id is null
               and capability = ${knownProviderUnknown.capability}
               and window_started_at = date_trunc('minute', now())) as rate_used
        `;
      });
      const { dispatch_token: recoveryDispatchToken, ...recoveredState } =
        recoveredProviderTask[0]!;
      assert.match(recoveryDispatchToken, /^[0-9a-f-]{36}$/);
      assert.deepEqual(recoveredState, {
        attempt_status: "materializing",
        job_status: "materializing",
        reservation_status: "reserved",
        recovery_outbox: 1,
        capacity_leases: 1,
        rate_used: rateBeforeReconcile + 1,
      });

      let recoveryMaterializations = 0;
      const recoveredAsset = {
        objectKey: `${workspaceId}/image/${knownProviderUnknown.job_id}/${knownProviderUnknown.attempt_id}.png`,
        mime: "image/png",
        bytes: 321n,
        sha256: "a".repeat(64),
        kind: "image" as const,
      };
      const recoveryExecutor = new GenerationExecutor(reconciliationRepository, {
        async recoverMaterialized() {
          return undefined;
        },
        async materialize() {
          recoveryMaterializations += 1;
          return recoveredAsset;
        },
      });
      const recoveryResult = await recoveryExecutor.execute(knownProviderInput, {
        workflowRunId: "unknown-provider-recovery-finalize",
        dispatchToken: recoveryDispatchToken,
        signal: new AbortController().signal,
      });
      assert.equal(recoveryResult.outcome, "succeeded");
      assert.equal(recoveryMaterializations, 1);
      assert.equal(providerPolls, 1);
      assert.equal(providerSubmits, 0);

      const recoveredCompletion = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<
          {
            assets: number;
            asset_events: number;
            attempt_status: string;
            job_status: string;
            reservation_status: string;
            settlements: number;
          }[]
        >`
          select
            (select count(*)::int from assets where object_key = ${recoveredAsset.objectKey}) as assets,
            (select count(*)::int from generation_job_events where attempt_id = ${knownProviderUnknown.attempt_id} and type = 'generation.job.asset_ready') as asset_events,
            (select status::text from generation_attempts where id = ${knownProviderUnknown.attempt_id}) as attempt_status,
            (select status::text from generation_jobs where id = ${knownProviderUnknown.job_id}) as job_status,
            (select status::text from credit_reservations where attempt_id = ${knownProviderUnknown.attempt_id}) as reservation_status,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id = ${knownProviderUnknown.attempt_id} and kind = 'settle') as settlements
        `;
      });
      assert.deepEqual(recoveredCompletion[0], {
        assets: 1,
        asset_events: 1,
        attempt_status: "succeeded",
        job_status: "succeeded",
        reservation_status: "settled",
        settlements: 1,
      });
    } finally {
      await sql.end();
    }
  },
);

test(
  "ten idempotent API submissions result in exactly three provider creates",
  { skip: !adminUrl },
  async () => {
    assert.ok(adminUrl);
    const sql = postgres(runtimeUrl(adminUrl), { max: 6, prepare: false });
    const workspaceId = "00000000-0000-4000-8000-00000000c102";
    const channelId = "00000000-0000-4000-8000-00000000c302";
    const config = loadWorkerConfig({
      NODE_ENV: "test",
      BUSINESS_DATABASE_URL: runtimeUrl(adminUrl),
      HATCHET_MODE: "cloud",
      HATCHET_CLIENT_TOKEN: "integration-token",
      OUTBOX_BATCH_SIZE: "3",
      CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      S3_REGION: "test",
      S3_ENDPOINT: "https://storage.example",
      S3_BUCKET: "test",
      S3_ACCESS_KEY_ID: "test-access",
      S3_SECRET_ACCESS_KEY: "test-secret",
    });
    const dispatched: {
      workflow: string;
      input: ReturnType<typeof generationWorkflowInputSchema.parse> & { dispatchToken: string };
      runId: string;
    }[] = [];
    const hatchet = {
      async runNoWait(workflow: string, input: ReturnType<typeof generationWorkflowInputSchema.parse> & { dispatchToken: string }) {
        const runId = `provider-create-gate:${input.attemptId}`;
        dispatched.push({ workflow, input, runId });
        return { async getWorkflowRunId() { return runId; } };
      },
      runs: { async cancel() {} },
    };

    try {
      const fixture = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const batches = await transaction<{ batch_id: string }[]>`
          select response_body->>'batchId' as batch_id
          from idempotency_requests
          where workspace_id = ${workspaceId} and operation = 'batch.create'
            and key = 'batch-provider-create-cap-0001'
        `;
        const batchId = batches[0]?.batch_id;
        assert.ok(batchId);
        const masterKey = Buffer.alloc(32);
        const dataKey = randomBytes(32);
        const nonce = randomBytes(12);
        await transaction`
          update provider_credentials
          set encrypted_data_key = ${encrypt(masterKey, nonce, dataKey)},
              encrypted_secret = ${encrypt(dataKey, nonce, Buffer.from("provider-create-secret"))},
              nonce = ${nonce.toString("base64")}
          where channel_id = ${channelId} and version = 1
        `;
        dataKey.fill(0);
        await transaction`
          update outbox_events
          set available_at = timestamptz '2000-01-01 00:00:00+00'
          where aggregate_id in (select id from generation_jobs where batch_id = ${batchId})
            and topic = 'generation.job.requested' and status = 'pending'
        `;
        const rows = await transaction<{ jobs: number; attempts: number; reservations: number; outbox: number }[]>`
          select
            (select count(*)::int from generation_jobs where batch_id = ${batchId}) as jobs,
            (select count(*)::int from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${batchId}) and status = 'created') as attempts,
            (select count(*)::int from credit_reservations where job_id in (select id from generation_jobs where batch_id = ${batchId}) and status = 'reserved') as reservations,
            (select count(*)::int from outbox_events where aggregate_id in (select id from generation_jobs where batch_id = ${batchId}) and status = 'pending') as outbox
        `;
        assert.deepEqual(rows[0], { jobs: 3, attempts: 3, reservations: 3, outbox: 3 });
        return { batchId };
      });

      const dispatcher = new OutboxDispatcher(sql, hatchet as never, config, "provider-create-gate");
      assert.equal(await dispatcher.dispatchOnce(), 3);
      assert.equal(dispatched.length, 3);
      assert.equal(new Set(dispatched.map(({ input }) => input.jobId)).size, 3);
      assert.equal(new Set(dispatched.map(({ input }) => input.attemptId)).size, 3);
      assert.equal(new Set(dispatched.map(({ input }) => input.dispatchToken)).size, 3);
      assert.ok(dispatched.every(({ workflow }) => workflow === "media-generation-v2"));

      let submitCalls = 0;
      let pollCalls = 0;
      let materializeCalls = 0;
      let recoverCalls = 0;
      const registry = new AdapterRegistry();
      registry.register({
        type: "grok2api",
        version: 1,
        capability: "image",
        validate() {},
        async submit() {
          submitCalls += 1;
          return {
            outcome: "completed",
            mediaUrls: [`https://media.example/provider-create-${submitCalls}.png`],
          };
        },
        async poll() {
          pollCalls += 1;
          return { status: "pending", nextPollDelayMs: 1_000 };
        },
      });
      const repository = new GenerationRepository(
        sql,
        config,
        registry,
        { trustedOrigin: () => "https://storage.example" } as never,
        randomUUID,
      );
      const executor = new GenerationExecutor(repository, {
        async materialize(_url, identity) {
          materializeCalls += 1;
          return {
            objectKey: `${identity.workspaceId}/generated/${identity.attemptId}/original`,
            mime: "image/png",
            bytes: 10n,
            sha256: identity.attemptId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
            kind: "image" as const,
          };
        },
        async recoverMaterialized() {
          recoverCalls += 1;
          return undefined;
        },
      });
      const results = await Promise.all(dispatched.map(({ input, runId }) =>
        executor.execute(
          generationWorkflowInputSchema.parse(input),
          {
            workflowRunId: runId,
            dispatchToken: input.dispatchToken,
            signal: new AbortController().signal,
          },
          {
            acquireLease: () => repository.acquireChannelCapacity(input, input.dispatchToken, runId),
            consumeProviderRequest: () => repository.consumeProviderRateCapacity(input, input.dispatchToken, runId),
          },
        ).then(async (result) => {
          if (["terminal", "succeeded", "failed"].includes(result.outcome)) {
            await repository.releaseChannelCapacity(input, input.dispatchToken);
          }
          return result;
        }),
      ));
      assert.deepEqual(results.map(({ outcome }) => outcome), ["succeeded", "succeeded", "succeeded"]);
      const replays = await Promise.all(dispatched.map(({ input, runId }) =>
        executor.execute(generationWorkflowInputSchema.parse(input), {
          workflowRunId: runId,
          dispatchToken: input.dispatchToken,
          signal: new AbortController().signal,
        }),
      ));
      assert.deepEqual(replays.map(({ outcome }) => outcome), ["terminal", "terminal", "terminal"]);
      assert.equal(submitCalls, 3);
      assert.equal(pollCalls, 0);
      assert.equal(materializeCalls, 3);
      assert.equal(recoverCalls, 0);

      const outcome = await sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<{
          succeeded: number; assets: number; sent: number; executorRuns: number; settled: number;
          reserves: number; settlements: number; releases: number; capacityLeases: number;
          workspaceRateUsed: number; channelRateUsed: number; available: string; reservedCredits: string;
        }[]>`
          select
            (select count(*)::int from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId}) and status = 'succeeded') as succeeded,
            (select count(*)::int from assets where id in (select output_asset_id from generation_jobs where batch_id = ${fixture.batchId})) as assets,
            (select count(*)::int from outbox_events where aggregate_id in (select id from generation_jobs where batch_id = ${fixture.batchId}) and status = 'sent') as sent,
            (select count(*)::int from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId}) and executor_run_id = 'provider-create-gate:' || id::text) as "executorRuns",
            (select count(*)::int from credit_reservations where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId}) and status = 'settled') as settled,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id in (select id from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId})) and kind = 'reserve') as reserves,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id in (select id from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId})) and kind = 'settle') as settlements,
            (select count(*)::int from wallet_entries where reference_type = 'attempt' and reference_id in (select id from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId})) and kind in ('release', 'release_after_unknown_timeout')) as releases,
            (select count(*)::int from provider_channel_capacity_leases where holder_id in (select id from generation_attempts where job_id in (select id from generation_jobs where batch_id = ${fixture.batchId}))) as "capacityLeases",
            coalesce((select sum(used)::int from generation_capacity_rate_windows where workspace_id = ${workspaceId} and capability = 'image'), 0) as "workspaceRateUsed",
            coalesce((select sum(used)::int from generation_capacity_rate_windows where channel_id = ${channelId} and capability = 'image'), 0) as "channelRateUsed",
            (select available::text from wallet_accounts where workspace_id = ${workspaceId}) as available,
            (select reserved::text from wallet_accounts where workspace_id = ${workspaceId}) as "reservedCredits"
        `;
      });
      assert.deepEqual(outcome[0], {
        succeeded: 3, assets: 3, sent: 3, executorRuns: 3, settled: 3, reserves: 3,
        settlements: 3, releases: 0, capacityLeases: 0,
        workspaceRateUsed: 3, channelRateUsed: 3, available: "970", reservedCredits: "0",
      });
    } finally {
      await sql.end();
    }
  },
);
