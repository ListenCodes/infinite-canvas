import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { strToU8, zipSync } from "fflate";

import { parseLocalDataArchive } from "./index.js";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("local export parser verifies manifest, records, and object checksums", () => {
  const projects = strToU8(JSON.stringify([{ sourceId: "local-project", title: "Project", documentJson: { nodes: [] } }]));
  const object = Uint8Array.from([137, 80, 78, 71]);
  const objectSha = sha(object);
  const assets = strToU8(JSON.stringify([{ sourceId: "local-asset", sha256: objectSha, bytes: "4", mime: "image/png", filename: "a.png" }]));
  const manifest = strToU8(JSON.stringify({
    format: "infinite-canvas-local-export",
    schemaVersion: 1,
    clientExportId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-10T00:00:00.000Z",
    counts: { projects: 1, assets: 1, objects: 1 },
    files: [
      { path: "data/projects.json", bytes: String(projects.byteLength), sha256: sha(projects), mediaType: "application/json" },
      { path: "data/assets.json", bytes: String(assets.byteLength), sha256: sha(assets), mediaType: "application/json" },
      { path: `objects/${objectSha}`, bytes: "4", sha256: objectSha, mediaType: "image/png" },
    ],
  }));
  const archive = zipSync({ "manifest.json": manifest, "data/projects.json": projects, "data/assets.json": assets, [`objects/${objectSha}`]: object });
  const parsed = parseLocalDataArchive(archive, 1024 * 1024);
  assert.equal(parsed.projects[0]?.sourceId, "local-project");
  assert.equal(parsed.objects.get(objectSha)?.byteLength, 4);
});

test("local export parser rejects path traversal", () => {
  const archive = zipSync({ "../escape": strToU8("bad") });
  assert.throws(() => parseLocalDataArchive(archive, 1024), /unsafe path/i);
});
