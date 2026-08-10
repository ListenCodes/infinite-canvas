import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeAdminCursor, encodeAdminCursor } from "./services/admin.js";

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
