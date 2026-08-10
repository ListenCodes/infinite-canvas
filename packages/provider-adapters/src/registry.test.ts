import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry, type MediaProviderAdapter } from "./index.js";

const adapter: MediaProviderAdapter = {
  type: "test",
  version: 1,
  capability: "image",
  validate: () => undefined,
  submit: async () => ({ outcome: "rejected", errorCode: "test", message: "test", retryable: false, acceptance: "not_accepted" }),
};

test("adapter registry resolves exact version and capability", () => {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  assert.equal(registry.get("test", 1, "image"), adapter);
  assert.throws(() => registry.get("test", 1, "video"));
  assert.throws(() => registry.register(adapter));
});
