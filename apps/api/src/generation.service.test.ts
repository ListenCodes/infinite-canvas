import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { GenerationService } from "./services/generation.js";
import { AdminService } from "./services/admin.js";

test("task pagination rejects malformed opaque cursor values before querying PostgreSQL", async () => {
  const service = new GenerationService({} as never, randomUUID, 86_400);
  for (const cursor of [
    { createdAt: "2026-99-99Tbad", jobId: randomUUID() },
    { createdAt: new Date().toISOString(), jobId: "------------------------------------" },
  ]) {
    const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    await assert.rejects(
      service.listJobs(randomUUID(), randomUUID(), encoded),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "invalid_request",
    );
  }
});

test("the worker handoff gate rejects operations that create generation work", async () => {
  const generation = new GenerationService({} as never, randomUUID, 86_400, false);
  for (const operation of [
    generation.createBatch(randomUUID(), {}, "handoff-create-0001"),
    generation.retryJob(randomUUID(), randomUUID(), "handoff-retry-0001"),
  ]) {
    await assert.rejects(
      operation,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "generation_writes_paused",
    );
  }

  const admin = new AdminService(
    {} as never,
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    1000n,
    randomUUID,
    false,
  );
  for (const [input, key] of [
    [
      {
        resolution: "accepted",
        providerTaskId: "provider-task-during-handoff",
        reason: "Confirmed by the provider operator",
        evidence: { source: "provider_console", reference: "case-handoff-1" },
      },
      "handoff-admin-0001",
    ],
    [
      {
        resolution: "provider_succeeded",
        mediaUrl: "https://media.example/result.png",
        reason: "Confirmed by the provider operator",
        evidence: { source: "provider_console", reference: "case-handoff-2" },
      },
      "handoff-admin-0002",
    ],
  ] as const) {
    await assert.rejects(
      admin.resolveUnknown(randomUUID(), randomUUID(), input, key),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "generation_writes_paused",
    );
  }
});
