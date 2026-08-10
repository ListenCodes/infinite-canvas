import { z } from "zod";

import { decimalUnsignedSchema, modelConfigIdSchema } from "./ids.js";
import { generationCapabilitySchema } from "./status.js";

export const modelProjectionSchema = z.object({
  modelConfigId: modelConfigIdSchema,
  model: z.string().min(1),
  capability: generationCapabilitySchema,
  channelName: z.string().min(1),
  providerType: z.enum(["grok2api", "sub2api", "openai"]),
  limits: z.record(z.string(), z.unknown()),
  unitCredits: decimalUnsignedSchema,
});
export const modelListResponseSchema = z.array(modelProjectionSchema);
export type ModelProjection = z.infer<typeof modelProjectionSchema>;
