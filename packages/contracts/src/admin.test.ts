import assert from "node:assert/strict";
import { test } from "node:test";

import { adminModelConfigInputSchema, unknownResolutionRequestSchema } from "./admin.js";

test("unknown resolution requires a structured nonempty evidence reference", () => {
  assert.equal(unknownResolutionRequestSchema.safeParse({
    resolution: "accepted",
    providerTaskId: "provider-task-1",
    reason: "Confirmed in provider console",
    evidence: {},
  }).success, false);
  assert.equal(unknownResolutionRequestSchema.safeParse({
    resolution: "accepted",
    providerTaskId: "provider-task-1",
    reason: "Confirmed in provider console",
    evidence: { source: "provider_console", reference: "case-123" },
  }).success, true);
});

test("model capacity policy values are bounded positive integers", () => {
  const valid = {
    model: "image-model",
    capability: "image",
    adapterType: "openai",
    concurrencyLimit: 4,
    rateLimitPerMinute: 60,
    creditAmount: "1",
  };
  assert.equal(adminModelConfigInputSchema.safeParse(valid).success, true);
  assert.equal(adminModelConfigInputSchema.safeParse({ ...valid, concurrencyLimit: 0 }).success, false);
  assert.equal(adminModelConfigInputSchema.safeParse({ ...valid, rateLimitPerMinute: 1.5 }).success, false);
  assert.equal(adminModelConfigInputSchema.safeParse({ ...valid, rateLimitPerMinute: 100_001 }).success, false);
});
