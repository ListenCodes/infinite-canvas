import { z } from "zod";

import { attemptIdSchema, decimalUnsignedSchema, jobIdSchema, workspaceIdSchema } from "./ids.js";
import { cloudFeatureFlagsSchema } from "./session.js";
import { generationCapabilitySchema, jobStatusSchema, outboxStatusSchema, reservationStatusSchema } from "./status.js";

const isoDateSchema = z.iso.datetime({ offset: true });
export const adminPageQuerySchema = z.object({
  cursor: z.string().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Only HTTP(S) URLs are allowed");

export const adminWorkspaceSummarySchema = z.object({
  workspaceId: workspaceIdSchema,
  name: z.string(),
  role: z.enum(["owner", "editor", "viewer"]),
});

export const adminUserSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  status: z.enum(["active", "disabled"]),
  platformRole: z.enum(["user", "admin"]),
  featureFlags: cloudFeatureFlagsSchema,
  lastLoginAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
  available: decimalUnsignedSchema,
  reserved: decimalUnsignedSchema,
  workspaces: z.array(adminWorkspaceSummarySchema),
});

export const adminUserStatusRequestSchema = z.object({
  status: z.enum(["active", "disabled"]),
  reason: z.string().trim().min(3).max(500),
});

export const adminUserStatusResponseSchema = z.object({
  userId: z.uuid(),
  status: z.enum(["active", "disabled"]),
});

export const adminUserFeaturesRequestSchema = z.object({
  featureFlags: cloudFeatureFlagsSchema,
  reason: z.string().trim().min(3).max(500),
});

export const adminUserFeaturesResponseSchema = z.object({
  userId: z.uuid(),
  featureFlags: cloudFeatureFlagsSchema,
});

export const adminWalletAdjustmentRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  amount: z.string().regex(/^-?[1-9]\d*$/),
  reason: z.string().trim().min(3).max(500),
  confirmLargeDebit: z.boolean().default(false),
});

export const adminWalletAdjustmentResponseSchema = z.object({
  workspaceId: workspaceIdSchema,
  available: decimalUnsignedSchema,
  reserved: decimalUnsignedSchema,
});

export const providerChannelInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  type: z.enum(["grok2api", "sub2api", "openai"]),
  baseUrl: httpUrlSchema,
  capabilities: z.array(generationCapabilitySchema).min(1),
});

export const providerChannelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(["grok2api", "sub2api", "openai"]),
  baseUrl: httpUrlSchema,
  capabilities: z.array(generationCapabilitySchema),
  status: z.enum(["active", "paused", "disabled"]),
  healthStatus: z.string(),
  credentialVersion: z.number().int().positive().nullable(),
  secretSuffix: z.string().max(32).nullable(),
  capacityPolicies: z.array(z.object({
    capability: generationCapabilitySchema,
    version: z.number().int().positive(),
    concurrencyLimit: z.number().int().positive(),
    rateLimitPerMinute: z.number().int().positive(),
  })),
});

export const providerChannelMutationResponseSchema = z.object({ id: z.uuid() });
export const providerCredentialInputSchema = z.object({ secret: z.string().min(8).max(20_000) });
export const providerCredentialResponseSchema = z.object({
  channelId: z.uuid(),
  version: z.number().int().positive(),
  secretSuffix: z.string().max(32),
});

export const adminModelConfigInputSchema = z.object({
  model: z.string().trim().min(1).max(200),
  capability: generationCapabilitySchema,
  adapterType: z.enum(["grok2api", "sub2api", "openai"]),
  adapterVersion: z.number().int().positive().default(1),
  limits: z.record(z.string(), z.unknown()).default({}),
  concurrencyLimit: z.number().int().min(1).max(100).default(3),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).default(60),
  providerIdempotencySupported: z.boolean().default(false),
  creditAmount: decimalUnsignedSchema,
});

export const adminModelConfigResponseSchema = z.object({
  modelConfigId: z.uuid(),
  configVersion: z.number().int().positive(),
});

export const adminJobSchema = z.object({
  jobId: jobIdSchema,
  workspaceId: workspaceIdSchema,
  batchId: z.uuid(),
  capability: generationCapabilitySchema,
  status: jobStatusSchema,
  version: z.number().int().nonnegative(),
  attemptId: attemptIdSchema,
  attemptNo: z.number().int().positive(),
  channelId: z.uuid(),
  providerTaskId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
  businessDeadlineAt: isoDateSchema,
  outcomeUnknownAt: isoDateSchema.nullable(),
  reconcileAfter: isoDateSchema.nullable(),
  releaseAfter: isoDateSchema.nullable(),
  reservationStatus: reservationStatusSchema.nullable(),
  reservedCredits: decimalUnsignedSchema.nullable(),
  outbox: z.array(z.object({
    status: outboxStatusSchema,
    dedupeKey: z.string(),
    lastError: z.string().nullable(),
    updatedAt: isoDateSchema,
  })),
  ledgerKinds: z.array(z.string()),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const unknownResolutionEvidenceSchema = z.object({
  source: z.string().trim().min(1).max(100),
  reference: z.string().trim().min(1).max(1000),
}).catchall(z.unknown()).refine(
  (value) => JSON.stringify(value).length <= 8_192,
  "Evidence must be at most 8192 serialized characters",
);

export const unknownResolutionRequestSchema = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.enum(["not_accepted", "provider_failed"]), reason: z.string().trim().min(3).max(500), evidence: unknownResolutionEvidenceSchema }),
  z.object({ resolution: z.literal("accepted"), providerTaskId: z.string().trim().min(1).max(500), reason: z.string().trim().min(3).max(500), evidence: unknownResolutionEvidenceSchema }),
  z.object({ resolution: z.literal("provider_succeeded"), mediaUrl: httpUrlSchema, reason: z.string().trim().min(3).max(500), evidence: unknownResolutionEvidenceSchema }),
]);

export const unknownResolutionResponseSchema = z.object({ attemptId: attemptIdSchema, status: jobStatusSchema });

export const adminAuditLogSchema = z.object({
  id: z.uuid(),
  workspaceId: workspaceIdSchema.nullable(),
  actorUserId: z.uuid().nullable(),
  actorType: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  reason: z.string().nullable(),
  beforeSummary: z.record(z.string(), z.unknown()).nullable(),
  afterSummary: z.record(z.string(), z.unknown()).nullable(),
  correlationId: z.string(),
  createdAt: isoDateSchema,
});

export const adminUserPageSchema = z.object({
  items: z.array(adminUserSchema),
  nextCursor: z.string().nullable(),
});
export const adminJobPageSchema = z.object({
  items: z.array(adminJobSchema),
  nextCursor: z.string().nullable(),
});
export const adminAuditPageSchema = z.object({
  items: z.array(adminAuditLogSchema),
  nextCursor: z.string().nullable(),
});

export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminJob = z.infer<typeof adminJobSchema>;
export type ProviderChannel = z.infer<typeof providerChannelSchema>;
export type AdminAuditLog = z.infer<typeof adminAuditLogSchema>;
