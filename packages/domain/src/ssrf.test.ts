import assert from "node:assert/strict";
import { test } from "node:test";

import { validateRemoteMediaUrl } from "./ssrf.js";

test("rejects bracketed private IPv6 URL literals", () => {
  assert.throws(() => validateRemoteMediaUrl("http://[::1]/metadata"), /not public/);
  assert.throws(() => validateRemoteMediaUrl("http://[fc00::1]/metadata"), /not public/);
});

test("accepts public HTTP media URLs only", () => {
  assert.equal(validateRemoteMediaUrl("https://media.example/file.png").protocol, "https:");
  assert.throws(() => validateRemoteMediaUrl("file:///etc/passwd"), /Only http and https/);
});
