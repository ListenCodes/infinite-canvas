import assert from "node:assert/strict";
import test from "node:test";

import { activeJobsSnapshotSchema, createGenerationBatchRequestSchema } from "./generation.js";
import { generationWorkflowInputSchema, generationWorkflowV1InputSchema } from "./workflow.js";

const id = "01988a21-3f0e-7b72-b59f-c5b78351fa80";

test("generation batches require one unique slot per requested output", () => {
  const valid = createGenerationBatchRequestSchema.safeParse({
    projectId: id,
    kind: "image",
    count: 3,
    target: { nodeId: "node-1", slotIds: ["slot-1", "slot-2", "slot-3"] },
    modelConfigId: id,
    input: { prompt: "draw", referenceAssetIds: [], parameters: {} },
    projectVersion: 1,
  });
  assert.equal(valid.success, true);

  const duplicate = createGenerationBatchRequestSchema.safeParse({
    projectId: id,
    kind: "image",
    count: 3,
    target: { nodeId: "node-1", slotIds: ["slot-1", "slot-1", "slot-2"] },
    modelConfigId: id,
    input: { prompt: "draw", referenceAssetIds: [], parameters: {} },
    projectVersion: 1,
  });
  assert.equal(duplicate.success, false);
});

test("active job snapshots carry authoritative node and slot targets", () => {
  const base = {
    projectId: id,
    projectVersion: 1,
    eventCursor: "4",
    jobs: [{
      batchId: id,
      jobId: id,
      slotIndex: 0,
      slotId: "slot-1",
      targetNodeId: "node-1",
      capability: "image",
      status: "running",
      jobVersion: 2,
      attemptId: id,
      attemptNo: 1,
    }],
  };
  assert.equal(activeJobsSnapshotSchema.safeParse(base).success, true);
  const missingTarget = structuredClone(base) as { jobs: Record<string, unknown>[] };
  delete missingTarget.jobs[0]!.targetNodeId;
  assert.equal(activeJobsSnapshotSchema.safeParse(missingTarget).success, false);
});

test("generation workflows freeze the design workspace concurrency per capability", () => {
  const base = {
    schemaVersion: 2,
    workflowName: "media-generation-v2",
    workspaceId: id,
    projectId: id,
    batchId: id,
    jobId: id,
    attemptId: id,
    channelId: id,
    capacity: {
      policyVersion: 1,
      workspaceConcurrencyLimit: 3,
      workspaceRateLimitPerMinute: 30,
      channelConcurrencyLimit: 4,
      channelRateLimitPerMinute: 60,
    },
  };
  assert.equal(generationWorkflowInputSchema.safeParse({ ...base, capability: "image" }).success, true);
  assert.equal(generationWorkflowInputSchema.safeParse({ ...base, capability: "video" }).success, false);
  assert.equal(generationWorkflowInputSchema.safeParse({
    ...base,
    capability: "video",
    capacity: { ...base.capacity, workspaceConcurrencyLimit: 2 },
  }).success, true);
  assert.equal(generationWorkflowV1InputSchema.safeParse({
    ...base,
    schemaVersion: 1,
    workflowName: "media-generation-v1",
    capability: "image",
    capacity: undefined,
  }).success, true);
  assert.equal(generationWorkflowInputSchema.safeParse({
    ...base,
    capacity: undefined,
    capability: "image",
  }).success, false);
});
