import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { GenerationService } from "./services/generation.js";

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
