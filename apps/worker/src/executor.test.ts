import assert from "node:assert/strict";
import { test } from "node:test";

import { generationWorkflowInputSchema } from "@infinite-canvas/contracts";
import type { MediaProviderAdapter } from "@infinite-canvas/provider-adapters";
import { ProviderRequestNotSubmittedError } from "@infinite-canvas/provider-adapters";

import {
  GenerationExecutor,
  NonRetryableExecutionError,
  RetryableExecutionError,
} from "./executor.js";
import type { AttemptExecution } from "./types.js";

const workflowInput = generationWorkflowInputSchema.parse({
  schemaVersion: 2,
  workflowName: "media-generation-v2",
  workspaceId: "00000000-0000-4000-8000-000000000101",
  projectId: "00000000-0000-4000-8000-000000000201",
  batchId: "00000000-0000-4000-8000-000000000601",
  jobId: "00000000-0000-4000-8000-000000000701",
  attemptId: "00000000-0000-4000-8000-000000000801",
  capability: "image",
  channelId: "00000000-0000-4000-8000-000000000301",
  capacity: {
    policyVersion: 1,
    workspaceConcurrencyLimit: 3,
    workspaceRateLimitPerMinute: 30,
    channelConcurrencyLimit: 2,
    channelRateLimitPerMinute: 60,
  },
});

function execution(adapter: MediaProviderAdapter): AttemptExecution {
  return {
    input: workflowInput,
    status: "claimed",
    providerTaskId: null,
    providerIdempotencySupported: false,
    businessDeadlineAt: new Date(Date.now() + 60_000),
    evidence: null,
    generation: {
      prompt: "draw",
      model: "test",
      capability: "image",
      parameters: {},
      referenceAssetIds: [],
      referenceAssets: [],
    },
    provider: {
      channelId: workflowInput.channelId,
      baseUrl: new URL("https://provider.example"),
      credential: "secret",
      signal: new AbortController().signal,
      idempotencyKey: workflowInput.attemptId,
    },
    adapter,
  };
}

function repositoryFor(value: AttemptExecution, calls: string[]) {
  return {
    async claim() {
      calls.push("claim");
      return "claimed" as const;
    },
    async load() {
      calls.push("load");
      return value;
    },
    async markSubmitting() {
      calls.push("submitting");
      return true;
    },
    async resetForRetry() {
      calls.push("reset");
    },
    async markAccepted() {
      calls.push("accepted");
    },
    async markMaterializing() {
      calls.push("materializing");
    },
    async markMaterialized() {
      calls.push("materialized");
    },
    async markUnknown() {
      calls.push("unknown");
    },
    async fail() {
      calls.push("failed");
    },
    async isCancelRequested() {
      return false;
    },
    async beginCancelAttempt() {
      calls.push("begin-cancel");
      return true;
    },
    async markCancelAttempted(
      _input: typeof workflowInput,
      _outcome: "not_supported" | "unknown",
      _executorClaimId: string,
    ) {
      calls.push("cancel-attempted");
    },
    async confirmCanceled() {
      calls.push("canceled");
    },
    async complete() {
      calls.push("complete");
      return "00000000-0000-4000-8000-000000000901";
    },
    async convergeFailure() {
      calls.push("converged");
    },
  };
}

function context() {
  return {
    workflowRunId: "run-1",
    dispatchToken: "00000000-0000-4000-8000-000000000099",
    signal: new AbortController().signal,
  };
}

test("capacity admission runs after the attempt claim and busy work does not load provider state", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      throw new Error("provider must not be called while capacity is busy");
    },
  };
  const executor = new GenerationExecutor(
    repositoryFor(execution(adapter), calls),
    {} as never,
  );
  const result = await executor.execute(workflowInput, context(), {
    async acquireLease() {
      calls.push("capacity");
      return "busy";
    },
    async consumeProviderRequest() {
      throw new Error("rate capacity must not be consumed without a lease");
    },
  });
  assert.deepEqual(result, { outcome: "pending", nextPollDelayMs: 3_000 });
  assert.deepEqual(calls, ["claim", "capacity"]);
});

test("an expired unsubmitted attempt fails without waiting for provider capacity", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      throw new Error("expired work must not call the provider");
    },
  };
  const result = await new GenerationExecutor(
    repositoryFor(execution(adapter), calls),
    {} as never,
  ).execute(workflowInput, context(), {
    async acquireLease() {
      calls.push("capacity");
      return "expired";
    },
    async consumeProviderRequest() {
      throw new Error("expired work must not consume provider RPM");
    },
  });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, ["claim", "capacity", "failed"]);
});

test("materialization recovery holds a lease without consuming provider rate capacity", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      throw new Error("materialization recovery must not submit");
    },
  };
  const materializing = execution(adapter);
  materializing.status = "materializing";
  materializing.evidence = {
    materializedAsset: {
      objectKey: "workspace/image/job/attempt/original",
      mime: "image/png",
      bytes: "10",
      sha256: "hash",
      kind: "image",
    },
  };
  const result = await new GenerationExecutor(
    repositoryFor(materializing, calls),
    {} as never,
  ).execute(workflowInput, context(), {
    async acquireLease() {
      calls.push("capacity");
      return "acquired";
    },
    async consumeProviderRequest() {
      calls.push("rate");
      return "acquired";
    },
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(calls.includes("rate"), false);
  assert.deepEqual(calls, ["claim", "capacity", "load", "materialized", "complete"]);
});

test("lost paid POST response enters outcome_unknown without materialization", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      calls.push("submit");
      throw new Error("connection reset after upload");
    },
  };
  const repository = repositoryFor(execution(adapter), calls);
  const storage = {
    async materialize() {
      calls.push("storage");
      throw new Error("must not run");
    },
    async recoverMaterialized() {
      return undefined;
    },
  };
  const executor = new GenerationExecutor(repository, storage);
  assert.equal(
    (await executor.execute(workflowInput, context())).outcome,
    "outcome_unknown",
  );
  assert.deepEqual(calls, ["claim", "load", "submitting", "submit", "unknown"]);
});

test("a provider-declared idempotent submission resumes with the same attempt key", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit(_input, provider) {
      calls.push(`submit:${provider.idempotencyKey}`);
      return {
        outcome: "completed",
        mediaUrls: ["https://media.example/recovered.png"],
      };
    },
  };
  const resumed = execution(adapter);
  resumed.status = "submitting";
  resumed.providerIdempotencySupported = true;
  const storage = {
    async recoverMaterialized() {
      return undefined;
    },
    async materialize() {
      calls.push("storage");
      return {
        objectKey: "key",
        mime: "image/png",
        bytes: 10n,
        sha256: "hash",
        kind: "image" as const,
      };
    },
  };
  const result = await new GenerationExecutor(
    repositoryFor(resumed, calls),
    storage,
  ).execute(workflowInput, context());
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(calls, [
    "claim",
    "load",
    `submit:${workflowInput.attemptId}`,
    "materializing",
    "storage",
    "materialized",
    "complete",
  ]);
});

test("definitely rejected transient request resets claim for Hatchet retry", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      return {
        outcome: "rejected",
        errorCode: "provider_rate_limited_not_accepted",
        message: "rate limited",
        retryable: true,
        acceptance: "not_accepted",
      };
    },
  };
  const executor = new GenerationExecutor(
    repositoryFor(execution(adapter), calls),
    {
      async materialize() {
        throw new Error("must not run");
      },
      async recoverMaterialized() {
        return undefined;
      },
    },
  );
  await assert.rejects(
    executor.execute(workflowInput, context()),
    RetryableExecutionError,
  );
  assert.deepEqual(calls, ["claim", "load", "submitting", "reset"]);
});

test("provider preparation failure retries without entering outcome_unknown", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      calls.push("prepare-reference");
      throw new ProviderRequestNotSubmittedError(
        "reference_asset_unavailable",
        "signed reference expired before provider POST",
        true,
      );
    },
  };
  const executor = new GenerationExecutor(
    repositoryFor(execution(adapter), calls),
    {
      async materialize() {
        throw new Error("must not materialize");
      },
      async recoverMaterialized() {
        return undefined;
      },
    },
  );
  await assert.rejects(
    executor.execute(workflowInput, context()),
    RetryableExecutionError,
  );
  assert.deepEqual(calls, [
    "claim",
    "load",
    "submitting",
    "prepare-reference",
    "reset",
  ]);
});

test("completed response materializes before immutable settlement", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      return {
        outcome: "completed",
        mediaUrls: ["https://media.example/image.png"],
      };
    },
  };
  const repository = repositoryFor(execution(adapter), calls);
  const storage = {
    async materialize() {
      calls.push("storage");
      return {
        objectKey: "key",
        mime: "image/png",
        bytes: 10n,
        sha256: "hash",
        kind: "image" as const,
      };
    },
    async recoverMaterialized() {
      return undefined;
    },
  };
  const result = await new GenerationExecutor(repository, storage).execute(
    workflowInput,
    context(),
  );
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(calls, [
    "claim",
    "load",
    "submitting",
    "materializing",
    "storage",
    "materialized",
    "complete",
  ]);
});

test("object write survives a crash before materialized evidence without repeating paid submit", async () => {
  const calls: string[] = [];
  const current = execution({
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      calls.push("submit");
      return {
        outcome: "completed",
        mediaUrls: ["https://media.example/recover.png"],
      };
    },
  });
  const repository = {
    async claim() {
      calls.push("claim");
      return "claimed" as const;
    },
    async load() {
      calls.push("load");
      return current;
    },
    async markSubmitting() {
      calls.push("submitting");
      current.status = "submitting";
      return true;
    },
    async resetForRetry() {},
    async markAccepted() {},
    async markMaterializing(_input: unknown, mediaUrl: URL) {
      calls.push("materializing");
      current.status = "materializing";
      current.evidence = { mediaUrls: [mediaUrl.toString()] };
    },
    async markMaterialized(
      _input: unknown,
      asset: {
        objectKey: string;
        mime: string;
        bytes: bigint;
        sha256: string;
        kind: "image" | "video";
      },
    ) {
      calls.push("materialized");
      current.evidence = {
        ...current.evidence,
        materializedAsset: { ...asset, bytes: asset.bytes.toString() },
      };
    },
    async markUnknown() {},
    async fail() {},
    async isCancelRequested() {
      return false;
    },
    async beginCancelAttempt() {
      return true;
    },
    async markCancelAttempted() {},
    async confirmCanceled() {},
    async complete() {
      calls.push("complete");
      return "00000000-0000-4000-8000-000000000901";
    },
    async convergeFailure() {},
  };
  let persistedAsset:
    | {
        objectKey: string;
        mime: string;
        bytes: bigint;
        sha256: string;
        kind: "image";
      }
    | undefined;
  let recoverCalls = 0;
  const storage = {
    async materialize() {
      calls.push("storage");
      persistedAsset = {
        objectKey: "key",
        mime: "image/png",
        bytes: 10n,
        sha256: "hash",
        kind: "image" as const,
      };
      throw new Error("worker terminated after object write");
    },
    async recoverMaterialized() {
      recoverCalls += 1;
      return persistedAsset;
    },
  };
  const executor = new GenerationExecutor(repository, storage);
  await assert.rejects(
    executor.execute(workflowInput, context()),
    /worker terminated after object write/,
  );
  assert.equal(
    (await executor.execute(workflowInput, context())).outcome,
    "succeeded",
  );
  assert.equal(calls.filter((call) => call === "submit").length, 1);
  assert.equal(calls.filter((call) => call === "storage").length, 1);
  assert.equal(recoverCalls, 1);
  assert.equal(calls.filter((call) => call === "materialized").length, 1);
  assert.equal(calls.filter((call) => call === "complete").length, 1);
});

test("moderation rejection is terminal and never retried as a network error", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      calls.push("submit");
      return {
        outcome: "rejected",
        errorCode: "content_moderation_rejected",
        message: "Prompt was rejected by content moderation",
        retryable: false,
        acceptance: "not_accepted",
      };
    },
  };
  const result = await new GenerationExecutor(
    repositoryFor(execution(adapter), calls),
    {
      async materialize() {
        throw new Error("must not materialize rejected output");
      },
      async recoverMaterialized() {
        return undefined;
      },
    },
  ).execute(workflowInput, context());
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, ["claim", "load", "submitting", "submit", "failed"]);
});

test("accepted video resumes from provider task id without another create POST", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "video",
    validate() {},
    async submit() {
      calls.push("submit");
      throw new Error("must not submit an accepted task");
    },
    async poll(taskId) {
      calls.push(`poll:${taskId}`);
      return {
        status: "succeeded",
        mediaUrls: [new URL("https://media.example/video.mp4")],
      };
    },
  };
  const resumed = execution(adapter);
  resumed.status = "accepted";
  resumed.providerTaskId = "provider-task-1";
  const repository = repositoryFor(resumed, calls);
  const storage = {
    async materialize() {
      calls.push("storage");
      return {
        objectKey: "video-key",
        mime: "video/mp4",
        bytes: 100n,
        sha256: "hash",
        kind: "video" as const,
      };
    },
    async recoverMaterialized() {
      return undefined;
    },
  };
  const result = await new GenerationExecutor(repository, storage).execute(
    workflowInput,
    context(),
  );
  assert.equal(result.outcome, "succeeded");
  assert.equal(calls.includes("submit"), false);
  assert.deepEqual(calls, [
    "claim",
    "load",
    "poll:provider-task-1",
    "materializing",
    "storage",
    "materialized",
    "complete",
  ]);
});

test("an accepted submit ends the activation before the first provider poll", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() {
      calls.push("submit");
      return { outcome: "accepted", providerTaskId: "provider-task-2", nextPollDelayMs: 4_000 };
    },
    async poll() {
      calls.push("poll");
      throw new Error("poll must run in a rate-limited follow-up activation");
    },
  };
  const result = await new GenerationExecutor(
    repositoryFor(execution(adapter), calls),
    {
      async materialize() { throw new Error("must not materialize"); },
      async recoverMaterialized() { return undefined; },
    },
  ).execute(workflowInput, context());
  assert.deepEqual(result, { outcome: "pending", nextPollDelayMs: 4_000 });
  assert.deepEqual(calls, ["claim", "load", "submitting", "submit", "accepted"]);
});

for (const cancellation of ["not_supported", "unknown"] as const) {
  test(`a ${cancellation} provider cancel is persisted and the next activation polls`, async () => {
    const calls: string[] = [];
    const adapter: MediaProviderAdapter = {
      type: "fake",
      version: 1,
      capability: "image",
      validate() {},
      async submit() { throw new Error("must not submit"); },
      async cancel() {
        calls.push(`cancel:${cancellation}`);
        return cancellation;
      },
      async poll() {
        calls.push("poll");
        return { status: "pending", nextPollDelayMs: 5_000 };
      },
    };
    const accepted = execution(adapter);
    accepted.status = "accepted";
    accepted.providerTaskId = "provider-task-cancel";
    accepted.evidence = {};
    const repository = repositoryFor(accepted, calls);
    repository.isCancelRequested = async () => true;
    repository.markCancelAttempted = async (_input, outcome) => {
      calls.push(`persist-cancel:${outcome}`);
      accepted.evidence = { providerCancel: { outcome } };
    };
    const executor = new GenerationExecutor(repository, {
      async materialize() { throw new Error("must not materialize"); },
      async recoverMaterialized() { return undefined; },
    });
    assert.deepEqual(await executor.execute(workflowInput, context()), {
      outcome: "pending",
      nextPollDelayMs: 3_000,
    });
    assert.deepEqual(await executor.execute(workflowInput, context()), {
      outcome: "pending",
      nextPollDelayMs: 5_000,
    });
    assert.deepEqual(calls, [
      "claim", "load", "begin-cancel", `cancel:${cancellation}`, `persist-cancel:${cancellation}`,
      "claim", "load", "poll",
    ]);
  });
}

test("a cancel transport error is persisted before the next activation polls", async () => {
  const calls: string[] = [];
  const adapter: MediaProviderAdapter = {
    type: "fake",
    version: 1,
    capability: "image",
    validate() {},
    async submit() { throw new Error("must not submit"); },
    async cancel() {
      calls.push("cancel");
      throw new Error("connection reset after cancel");
    },
    async poll() {
      calls.push("poll");
      return { status: "pending", nextPollDelayMs: 5_000 };
    },
  };
  const accepted = execution(adapter);
  accepted.status = "accepted";
  accepted.providerTaskId = "provider-task-cancel-error";
  accepted.evidence = {};
  const repository = repositoryFor(accepted, calls);
  repository.isCancelRequested = async () => true;
  repository.markCancelAttempted = async (_input, outcome) => {
    calls.push(`persist-cancel:${outcome}`);
    accepted.evidence = { providerCancel: { outcome } };
  };
  const executor = new GenerationExecutor(repository, {
    async materialize() { throw new Error("must not materialize"); },
    async recoverMaterialized() { return undefined; },
  });
  assert.deepEqual(await executor.execute(workflowInput, context()), {
    outcome: "pending",
    nextPollDelayMs: 3_000,
  });
  assert.deepEqual(await executor.execute(workflowInput, context()), {
    outcome: "pending",
    nextPollDelayMs: 5_000,
  });
  assert.deepEqual(calls, [
    "claim", "load", "begin-cancel", "cancel", "persist-cancel:unknown",
    "claim", "load", "poll",
  ]);
});
