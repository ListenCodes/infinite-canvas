import { z } from "zod";

import { attemptIdSchema, batchIdSchema, eventSequenceSchema, jobIdSchema, projectIdSchema, workspaceIdSchema } from "./ids.js";

export const generationEventTypeSchema = z.enum([
  "generation.job.created",
  "generation.job.state_changed",
  "generation.job.progress",
  "generation.job.asset_ready",
  "generation.job.failed",
  "generation.job.cancel_requested",
  "generation.batch.updated",
  "wallet.balance_changed",
  "project.version_changed",
]);

export const generationEventSchema = z.object({
  sequence: eventSequenceSchema,
  type: generationEventTypeSchema,
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema.optional(),
  batchId: batchIdSchema.optional(),
  jobId: jobIdSchema.optional(),
  attemptId: attemptIdSchema.optional(),
  attemptNo: z.number().int().positive().optional(),
  jobVersion: z.number().int().nonnegative().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export type GenerationEventType = z.infer<typeof generationEventTypeSchema>;
export type GenerationEvent = z.infer<typeof generationEventSchema>;
