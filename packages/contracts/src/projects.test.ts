import assert from "node:assert/strict";
import test from "node:test";

import { createProjectRequestSchema } from "./projects.js";

const workspaceId = "00000000-0000-4000-8000-000000000101";

test("project creation requires an explicit workspace and one consistent client identity", () => {
  const valid = {
    workspaceId,
    clientProjectId: "local-project-1",
    title: "Project",
    documentJson: {
      schemaVersion: 1 as const,
      localProjectId: "local-project-1",
      document: {},
    },
  };
  assert.equal(createProjectRequestSchema.safeParse(valid).success, true);
  assert.equal(createProjectRequestSchema.safeParse({ ...valid, workspaceId: undefined }).success, false);
  assert.equal(createProjectRequestSchema.safeParse({ ...valid, clientProjectId: "different-project" }).success, false);
});
