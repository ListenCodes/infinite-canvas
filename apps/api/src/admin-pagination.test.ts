import assert from "node:assert/strict";
import { test } from "node:test";

import { AdminService, decodeAdminCursor, encodeAdminCursor } from "./services/admin.js";

const id = "00000000-0000-4000-8000-000000000001";
const createdAt = "2026-08-10T00:00:00.000Z";

test("admin cursor is scoped and round-trips the composite ordering key", () => {
  const cursor = encodeAdminCursor("users", { createdAt, id });
  assert.deepEqual(decodeAdminCursor("users", cursor), { createdAt, id });
  assert.throws(
    () => decodeAdminCursor("jobs", cursor),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "invalid_admin_cursor",
  );
});

test("admin cursor rejects malformed dates and database identifiers", () => {
  for (const payload of [
    { v: 1, scope: "audit", createdAt: "not-a-date", id },
    { v: 1, scope: "audit", createdAt, id: "not-a-uuid" },
  ]) {
    const cursor = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    assert.throws(() => decodeAdminCursor("audit", cursor));
  }
});

test("admin job pages normalize nullable attempt evidence to an empty object", async () => {
  const timestamp = new Date(createdAt);
  const transaction = async (strings: TemplateStringsArray) => {
    if (strings.join(" ").includes("set_config")) return [];
    return [{
      id,
      workspace_id: id,
      batch_id: id,
      capability: "image",
      status: "queued",
      version: 0,
      attempt_id: id,
      attempt_no: 1,
      channel_id: id,
      provider_task_id: null,
      error_code: null,
      error_message: null,
      evidence_json: null,
      business_deadline_at: timestamp,
      outcome_unknown_at: null,
      reconcile_after: null,
      release_after: null,
      reservation_status: null,
      reserved_credits: null,
      outbox_events: [],
      ledger_kinds: [],
      created_at: timestamp,
      updated_at: timestamp,
    }];
  };
  const sql = {
    begin: async (callback: (value: unknown) => unknown) => callback(transaction),
  };
  const service = new AdminService(
    sql as never,
    Buffer.alloc(32).toString("base64"),
    100n,
    () => id,
  );

  const page = await service.jobsPage({ limit: 10 });

  assert.deepEqual(page.items[0]?.evidence, {});
});
