import { z } from "zod";

import { assetIdSchema, attemptIdSchema, batchIdSchema, decimalUnsignedSchema, eventSequenceSchema, jobIdSchema, modelConfigIdSchema, nodeIdSchema, projectIdSchema, slotIdSchema, workspaceIdSchema } from "./ids.js";
import { batchStatusSchema, generationCapabilitySchema, jobStatusSchema } from "./status.js";

const generationInputSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  size: z.string().trim().min(1).max(64).optional(),
  durationSeconds: z.number().int().positive().max(600).optional(),
  referenceAssetIds: z.array(assetIdSchema).max(8).default([]),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

export const createGenerationBatchRequestSchema = z.object({
  projectId: projectIdSchema,
  kind: generationCapabilitySchema,
  count: z.number().int().min(1).max(15),
  target: z.object({
    nodeId: nodeIdSchema,
    slotIds: z.array(slotIdSchema).min(1).max(15),
  }),
  modelConfigId: modelConfigIdSchema,
  input: generationInputSchema,
  projectVersion: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  if (value.count !== value.target.slotIds.length) {
    context.addIssue({ code: "custom", path: ["target", "slotIds"], message: "count must equal slotIds length" });
  }
  if (new Set(value.target.slotIds).size !== value.target.slotIds.length) {
    context.addIssue({ code: "custom", path: ["target", "slotIds"], message: "slotIds must be unique" });
  }
});

export const generationJobProjectionSchema = z.object({
  batchId: batchIdSchema,
  jobId: jobIdSchema,
  slotIndex: z.number().int().nonnegative(),
  slotId: slotIdSchema,
  status: jobStatusSchema,
  jobVersion: z.number().int().nonnegative(),
  attemptId: attemptIdSchema,
  attemptNo: z.number().int().positive(),
  progress: z.number().int().min(0).max(100).optional(),
  assetId: assetIdSchema.optional(),
  errorCode: z.string().max(128).optional(),
  errorMessage: z.string().max(500).optional(),
});

export const createGenerationBatchResponseSchema = z.object({
  batchId: batchIdSchema,
  status: batchStatusSchema,
  jobs: z.array(generationJobProjectionSchema),
  credits: z.object({
    reserved: decimalUnsignedSchema,
    available: decimalUnsignedSchema,
  }),
  eventCursor: eventSequenceSchema,
});

export const generationBatchSnapshotSchema = z.object({
  batchId: batchIdSchema,
  projectId: projectIdSchema,
  status: batchStatusSchema,
  requestedCount: z.number().int().positive(),
  jobs: z.array(generationJobProjectionSchema),
  eventCursor: eventSequenceSchema,
});

export const cancelGenerationJobResponseSchema = z.object({ status: jobStatusSchema });

export const activeGenerationJobProjectionSchema = generationJobProjectionSchema.extend({
  targetNodeId: nodeIdSchema,
  capability: generationCapabilitySchema,
});

export const activeJobsSnapshotSchema = z.object({
  projectId: projectIdSchema,
  projectVersion: z.number().int().nonnegative(),
  jobs: z.array(activeGenerationJobProjectionSchema),
  eventCursor: eventSequenceSchema,
});

export const generationTaskProjectionSchema = generationJobProjectionSchema.extend({
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema,
  capability: generationCapabilitySchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const generationTaskListResponseSchema = z.object({
  jobs: z.array(generationTaskProjectionSchema),
  eventCursor: eventSequenceSchema,
  nextCursor: z.string().min(1).max(512).nullable(),
});

export type CreateGenerationBatchRequest = z.infer<typeof createGenerationBatchRequestSchema>;
export type CreateGenerationBatchResponse = z.infer<typeof createGenerationBatchResponseSchema>;
export type GenerationJobProjection = z.infer<typeof generationJobProjectionSchema>;
export type GenerationBatchSnapshot = z.infer<typeof generationBatchSnapshotSchema>;
export type CancelGenerationJobResponse = z.infer<typeof cancelGenerationJobResponseSchema>;
export type ActiveGenerationJobProjection = z.infer<typeof activeGenerationJobProjectionSchema>;
export type ActiveJobsSnapshot = z.infer<typeof activeJobsSnapshotSchema>;
export type GenerationTaskProjection = z.infer<typeof generationTaskProjectionSchema>;
export type GenerationTaskListResponse = z.infer<typeof generationTaskListResponseSchema>;
