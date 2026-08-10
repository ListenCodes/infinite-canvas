import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeMigrationAudit } from "./recovery-audit-format.js";

test("recovery migration audit normalizes Date and PostgreSQL timestamp strings", () => {
  assert.deepEqual(
    summarizeMigrationAudit([
      { name: "first", sha256: "a", applied_at: new Date("2026-08-10T00:00:00.000Z") },
      { name: "second", sha256: "b", applied_at: "2026-08-10 01:02:03+00" },
    ]),
    {
      count: 2,
      lastAppliedAt: "2026-08-10T01:02:03.000Z",
      entries: [
        { name: "first", sha256: "a", appliedAt: "2026-08-10T00:00:00.000Z" },
        { name: "second", sha256: "b", appliedAt: "2026-08-10T01:02:03.000Z" },
      ],
    },
  );
});

test("recovery migration audit rejects invalid timestamps", () => {
  assert.throws(
    () => summarizeMigrationAudit([{ name: "broken", sha256: "c", applied_at: "not-a-timestamp" }]),
    /Migration broken has an invalid applied_at timestamp/,
  );
});
