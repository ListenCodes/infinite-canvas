import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePublicAddresses } from "./secure-fetch.js";

test("rejects a hostname when any resolved address is private", async () => {
  await assert.rejects(
    resolvePublicAddresses("provider.example", async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /not public/,
  );
});

test("returns the exact public addresses that will be pinned by the connector", async () => {
  const expected = [{ address: "2001:4860:4860::8888", family: 6 as const }];
  assert.deepEqual(await resolvePublicAddresses("provider.example", async () => expected), expected);
});
