import assert from "node:assert/strict";
import { test } from "node:test";

import {
  publicGenerationErrorMessage,
  publicImportErrorMessage,
} from "./public-errors.js";

test("public errors never reflect persisted internal diagnostics", () => {
  const internal = `https://internal.example/token=${"secret".repeat(100)}`;
  const generation = publicGenerationErrorMessage(internal);
  const migration = publicImportErrorMessage(internal);
  assert.equal(generation.includes("internal.example"), false);
  assert.equal(migration.includes("internal.example"), false);
  assert.ok(generation.length <= 500);
  assert.ok(migration.length <= 500);
});

test("moderation failures remain explicit for the affected slot", () => {
  assert.match(
    publicGenerationErrorMessage("content_moderation_rejected"),
    /content policy/i,
  );
});
