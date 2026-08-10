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
  schemaVersion: 1,
  workflowName: "media-generation-v1",
  workspaceId: "00000000-0000-4000-8000-000000000101",
  projectId: "00000000-0000-4000-8000-000000000201",
  batchId: "00000000-0000-4000-8000-000000000601",
  jobId: "00000000-0000-4000-8000-000000000701",
  attemptId: "00000000-0000-4000-8000-000000000801",
  capability: "image",
  channelId: "00000000-0000-4000-8000-000000000301",
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
