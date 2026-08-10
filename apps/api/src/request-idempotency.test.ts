import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertIdempotencyKey,
  idempotencyRequestHash,
} from "./request-idempotency.js";

test("idempotency request hashing is independent of object key order", () => {
  assert.equal(
    idempotencyRequestHash({ b: 2, a: { d: 4, c: 3 } }),
    idempotencyRequestHash({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("idempotency keys reject missing or unsafe values", () => {
  assert.doesNotThrow(() => assertIdempotencyKey("safe-key:123"));
  assert.throws(() => assertIdempotencyKey(""), /Idempotency-Key/);
  assert.throws(() => assertIdempotencyKey("unsafe key"), /Idempotency-Key/);
});
