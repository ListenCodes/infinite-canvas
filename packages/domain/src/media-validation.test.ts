import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { validateMediaFile } from "./media-validation.js";

test("fully decodes a valid image and rejects a truncated one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infinite-canvas-media-test-"));
  try {
    const valid = join(directory, "valid.png");
    const invalid = join(directory, "invalid.png");
    await sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } }).png().toFile(valid);
    await writeFile(invalid, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(await validateMediaFile({ path: valid, mime: "image/png", kind: "image", maxImagePixels: 100, maxDurationSeconds: 60 }), { width: 2, height: 3 });
    await assert.rejects(validateMediaFile({ path: invalid, mime: "image/png", kind: "image", maxImagePixels: 100, maxDurationSeconds: 60 }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
