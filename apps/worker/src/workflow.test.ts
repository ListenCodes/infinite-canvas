import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyLimitStrategy, type HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";

import { createMediaGenerationWorkflow } from "./workflow.js";

test("generation workflow idempotency is scoped to the persisted dispatch generation", () => {
  let workflowOptions: Record<string, unknown> | undefined;
  const taskOptions: Record<string, unknown>[] = [];
  const workflow = {
    durableTask() {},
    onFailure() {},
  };
  const hatchet = {
    task(options: Record<string, unknown>) {
      taskOptions.push(options);
      return {};
    },
    workflow(options: Record<string, unknown>) {
      workflowOptions = options;
      return workflow;
    },
  } as unknown as HatchetClient;

  createMediaGenerationWorkflow(hatchet, {} as never, {
    async acquireChannelCapacity() { return "acquired"; },
    async consumeProviderRateCapacity() { return "acquired"; },
    async releaseChannelCapacity() {},
  });

  assert.deepEqual(workflowOptions?.idempotency, {
    strategy: "status",
    expression: "input.dispatchToken",
    fallbackTtlMs: 48 * 60 * 60 * 1000,
  });
  assert.equal(workflowOptions?.version, "2");
  assert.equal(taskOptions.length, 2);
  for (const [index, capability] of ["image", "video"].entries()) {
    const options = taskOptions[index]!;
    assert.deepEqual(options.concurrency, {
      expression: `'workspace:' + input.workspaceId + ':${capability}'`,
      maxRuns: capability === "image" ? 3 : 2,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    });
    assert.equal(options.rateLimits, undefined);
    assert.equal(options.slotCost, capability === "image" ? 1 : 2);
  }
});

test("outcome_unknown retains capacity while terminal outcomes release it", async () => {
  const taskOptions: Record<string, unknown>[] = [];
  const releases: string[] = [];
  let outcome: "outcome_unknown" | "failed" = "outcome_unknown";
  const workflow = { durableTask() {}, onFailure() {} };
  const hatchet = {
    task(options: Record<string, unknown>) {
      taskOptions.push(options);
      return {};
    },
    workflow() {
      return workflow;
    },
  } as unknown as HatchetClient;
  const executor = {
    async execute(
      _input: unknown,
      _context: unknown,
      capacity: {
        acquireLease(): Promise<"acquired" | "busy" | "expired" | "terminal">;
        consumeProviderRequest(): Promise<"acquired" | "busy" | "terminal">;
      },
    ) {
      await capacity.acquireLease();
      await capacity.consumeProviderRequest();
      return { outcome };
    },
  };
  const capacity = {
    async acquireChannelCapacity() { return "acquired" as const; },
    async consumeProviderRateCapacity() { return "acquired" as const; },
    async releaseChannelCapacity() { releases.push(outcome); },
  };
  createMediaGenerationWorkflow(hatchet, executor as never, capacity);
  const imageTask = taskOptions[0] as { fn: (input: unknown, context: unknown) => Promise<unknown> };
  const input = {
    schemaVersion: 2,
    workflowName: "media-generation-v2",
    workspaceId: "00000000-0000-4000-8000-000000000101",
    projectId: "00000000-0000-4000-8000-000000000201",
    batchId: "00000000-0000-4000-8000-000000000601",
    jobId: "00000000-0000-4000-8000-000000000701",
    attemptId: "00000000-0000-4000-8000-000000000801",
    capability: "image",
    channelId: "00000000-0000-4000-8000-000000000301",
    dispatchToken: "00000000-0000-4000-8000-000000000099",
    executorClaimId: "run-1",
    capacity: {
      policyVersion: 1,
      workspaceConcurrencyLimit: 3,
      workspaceRateLimitPerMinute: 30,
      channelConcurrencyLimit: 2,
      channelRateLimitPerMinute: 60,
    },
  };
  const context = { abortController: new AbortController() };
  await imageTask.fn(input, context);
  assert.deepEqual(releases, []);
  outcome = "failed";
  await imageTask.fn(input, context);
  assert.deepEqual(releases, ["failed"]);
});
