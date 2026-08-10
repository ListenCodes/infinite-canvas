import assert from "node:assert/strict";
import test from "node:test";

import { activeJobsSnapshotSchema, createGenerationBatchRequestSchema } from "./generation.js";

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
