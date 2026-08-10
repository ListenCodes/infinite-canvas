import { z } from "zod";

import { attemptIdSchema, batchIdSchema, channelIdSchema, jobIdSchema, projectIdSchema, workspaceIdSchema } from "./ids.js";
import { providerAcceptanceSchema } from "./errors.js";
import { generationCapabilitySchema } from "./status.js";

export const generationCapacitySnapshotSchema = z.object({
  policyVersion: z.number().int().positive(),
  workspaceConcurrencyLimit: z.number().int().positive(),
  workspaceRateLimitPerMinute: z.number().int().positive(),
  channelConcurrencyLimit: z.number().int().positive(),
  channelRateLimitPerMinute: z.number().int().positive(),
});

const generationWorkflowIdentitySchema = z.object({
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema,
  batchId: batchIdSchema,
  jobId: jobIdSchema,
  attemptId: attemptIdSchema,
  capability: generationCapabilitySchema,
  channelId: channelIdSchema,
});

export const generationWorkflowV1InputSchema = generationWorkflowIdentitySchema.extend({
  schemaVersion: z.literal(1),
  workflowName: z.literal("media-generation-v1"),
});

export const generationWorkflowInputSchema = generationWorkflowIdentitySchema.extend({
  schemaVersion: z.literal(2),
  workflowName: z.literal("media-generation-v2"),
  capacity: generationCapacitySnapshotSchema,
}).superRefine((value, context) => {
  const expectedWorkspaceConcurrency = value.capability === "image" ? 3 : 2;
  if (value.capacity.workspaceConcurrencyLimit !== expectedWorkspaceConcurrency) {
    context.addIssue({
      code: "custom",
      path: ["capacity", "workspaceConcurrencyLimit"],
      message: `media-generation-v2 requires workspace concurrency ${expectedWorkspaceConcurrency} for ${value.capability}`,
    });
  }
});

export const localDataImportWorkflowInputSchema = z.object({
  schemaVersion: z.literal(1),
  workflowName: z.literal("local-data-import-v1"),
  importId: z.uuid(),
  workspaceId: workspaceIdSchema,
  userId: z.uuid(),
  objectKey: z.string().min(1).max(1000),
});

export const claimAttemptResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("claimed"), executorClaimId: z.string().min(1) }),
  z.object({ outcome: z.literal("duplicate"), executorClaimId: z.string().min(1).nullable() }),
  z.object({ outcome: z.literal("terminal") }),
]);

const remoteHttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Only http and https URLs are allowed");

export const providerSubmitResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed"), mediaUrls: z.array(remoteHttpUrlSchema.or(z.string().startsWith("data:"))).min(1) }),
  z.object({ outcome: z.literal("accepted"), providerTaskId: z.string().min(1), nextPollDelayMs: z.number().int().positive() }),
  z.object({
    outcome: z.literal("rejected"),
    errorCode: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    acceptance: providerAcceptanceSchema,
  }),
  z.object({ outcome: z.literal("outcome_unknown"), message: z.string().min(1) }),
]);

export type GenerationWorkflowInput = z.infer<typeof generationWorkflowInputSchema>;
export type GenerationWorkflowV1Input = z.infer<typeof generationWorkflowV1InputSchema>;
export type GenerationCapacitySnapshot = z.infer<typeof generationCapacitySnapshotSchema>;
export type ClaimAttemptResult = z.infer<typeof claimAttemptResultSchema>;
export type ProviderSubmitResult = z.infer<typeof providerSubmitResultSchema>;
export type LocalDataImportWorkflowInput = z.infer<typeof localDataImportWorkflowInputSchema>;
