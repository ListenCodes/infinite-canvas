import assert from "node:assert/strict";
import { test } from "node:test";

import postgres from "postgres";

import { jsonParameter } from "./json-parameter.js";

test("database JSON parameters preserve objects instead of encoding JSON strings", () => {
  const sql = postgres("postgresql://unused:unused@127.0.0.1:1/unused", { max: 1 });
  const value = { document: { nodes: [{ id: "node-1" }] }, optional: undefined };
  const parameter = jsonParameter(sql, value) as unknown as { type: number; value: unknown };

  assert.equal(parameter.type, 3802);
  assert.deepEqual(parameter.value, { document: { nodes: [{ id: "node-1" }] } });
});

test("database JSON parameters reject non-serializable root values", () => {
  const sql = postgres("postgresql://unused:unused@127.0.0.1:1/unused", { max: 1 });
  assert.throws(() => jsonParameter(sql, undefined), /must be serializable/);
});
