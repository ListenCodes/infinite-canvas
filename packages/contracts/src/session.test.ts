import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adminUserFeaturesRequestSchema,
  sessionBootstrapResponseSchema,
} from "./index.js";

test("session bootstrap carries server-authoritative rollout flags", () => {
  const parsed = sessionBootstrapResponseSchema.parse({
    userId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000101",
    role: "owner",
    platformRole: "user",
    featureFlags: {
      projects: true,
      imageGeneration: true,
      videoGeneration: false,
      credits: true,
    },
    wallet: { available: "10", reserved: "2" },
    cloudImageEnabled: true,
  });
  assert.deepEqual(parsed.featureFlags, {
    projects: true,
    imageGeneration: true,
    videoGeneration: false,
    credits: true,
  });
  assert.equal("cloudImageEnabled" in parsed, false);
});

test("admin rollout mutations require complete flags and an audit reason", () => {
  assert.equal(
    adminUserFeaturesRequestSchema.safeParse({
      featureFlags: {
        projects: true,
        imageGeneration: true,
        videoGeneration: false,
        credits: true,
      },
      reason: "Enable the image canary cohort",
    }).success,
    true,
  );
  assert.equal(
    adminUserFeaturesRequestSchema.safeParse({
      featureFlags: { projects: true },
      reason: "ok",
    }).success,
    false,
  );
});
