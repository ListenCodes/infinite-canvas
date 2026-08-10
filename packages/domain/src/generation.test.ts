import assert from "node:assert/strict";
import test from "node:test";

import { aggregateBatchStatus, calculateCreditTotal, canTransitionJob } from "./generation.js";
import { normalizeProviderFailure } from "./provider-errors.js";
import { assertPublicAddress, validateRemoteMediaUrl } from "./ssrf.js";

test("job state transitions reject late attempts overwriting terminal jobs", () => {
  assert.equal(canTransitionJob("running", "materializing"), true);
  assert.equal(canTransitionJob("succeeded", "running"), false);
  assert.equal(canTransitionJob("failed", "succeeded"), false);
});

test("batch aggregation preserves partial success", () => {
  assert.equal(aggregateBatchStatus(["succeeded", "failed", "failed"]), "partial_succeeded");
  assert.equal(aggregateBatchStatus(["succeeded", "succeeded", "succeeded"]), "succeeded");
  assert.equal(aggregateBatchStatus(["canceled", "canceled"]), "canceled");
});

test("credit totals use bigint and reject invalid counts", () => {
  assert.equal(calculateCreditTotal(100n, 3), 300n);
  assert.throws(() => calculateCreditTotal(100n, 16));
});

test("ambiguous paid submissions are never retryable", () => {
  assert.deepEqual(normalizeProviderFailure({ acceptance: "unknown", message: "socket closed" }), {
    code: "provider_outcome_unknown",
    retryable: false,
    acceptance: "unknown",
  });
  assert.equal(normalizeProviderFailure({ acceptance: "not_accepted", status: 429 }).retryable, true);
});

test("content moderation is a clear non-retryable provider failure", () => {
  assert.equal(normalizeProviderFailure({ acceptance: "not_accepted", status: 400, message: "content moderation rejected" }).code, "content_moderation_rejected");
});

test("media URL validation blocks local and private targets", () => {
  assert.equal(validateRemoteMediaUrl("https://cdn.example.com/file.png").hostname, "cdn.example.com");
  assert.throws(() => validateRemoteMediaUrl("http://127.0.0.1/file"));
  assert.throws(() => validateRemoteMediaUrl("http://metadata.google.internal/latest"));
  assert.throws(() => assertPublicAddress("10.1.2.3"));
  assert.doesNotThrow(() => assertPublicAddress("1.1.1.1"));
});
