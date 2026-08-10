import assert from "node:assert/strict";
import test from "node:test";

import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";

import { createMediaGenerationWorkflow } from "./workflow.js";

test("generation workflow idempotency is scoped to the persisted dispatch generation", () => {
  let workflowOptions: Record<string, unknown> | undefined;
  const workflow = {
    durableTask() {},
    onFailure() {},
  };
  const hatchet = {
    task() {
      return {};
    },
    workflow(options: Record<string, unknown>) {
      workflowOptions = options;
      return workflow;
    },
  } as unknown as HatchetClient;

  createMediaGenerationWorkflow(hatchet, {} as never);

  assert.deepEqual(workflowOptions?.idempotency, {
    strategy: "status",
    expression: "input.dispatchToken",
    fallbackTtlMs: 48 * 60 * 60 * 1000,
  });
});
