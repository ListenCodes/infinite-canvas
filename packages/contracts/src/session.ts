import { z } from "zod";

import { decimalUnsignedSchema, workspaceIdSchema } from "./ids.js";

export const cloudFeatureFlagsSchema = z.object({
  projects: z.boolean(),
  imageGeneration: z.boolean(),
  videoGeneration: z.boolean(),
  credits: z.boolean(),
});

export const sessionBootstrapResponseSchema = z.object({
  userId: z.uuid(),
  workspaceId: workspaceIdSchema,
  role: z.enum(["owner", "editor", "viewer"]),
  platformRole: z.enum(["user", "admin"]),
  featureFlags: cloudFeatureFlagsSchema,
  wallet: z.object({
    available: decimalUnsignedSchema,
    reserved: decimalUnsignedSchema,
  }),
});

export type SessionBootstrapResponse = z.infer<typeof sessionBootstrapResponseSchema>;
export type CloudFeatureFlags = z.infer<typeof cloudFeatureFlagsSchema>;
