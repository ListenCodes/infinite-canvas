import assert from "node:assert/strict";
import { test } from "node:test";

import { unknownResolutionRequestSchema } from "./admin.js";

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
