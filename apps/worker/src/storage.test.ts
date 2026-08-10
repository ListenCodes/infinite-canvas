import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { WorkerConfig } from "./config.js";
import { ObjectStorage } from "./storage.js";

const config = {
  S3_REGION: "auto",
  S3_ENDPOINT: "https://storage.example.com",
  S3_BUCKET: "private-assets",
  S3_ACCESS_KEY_ID: "test-access",
  S3_SECRET_ACCESS_KEY: "test-secret",
  S3_FORCE_PATH_STYLE: "true",
  MAX_MEDIA_BYTES: 1024 * 1024,
  MAX_IMAGE_PIXELS: 100,
  MAX_MEDIA_DURATION_SECONDS: 60,
  FFPROBE_PATH: "ffprobe",
  FFMPEG_PATH: "ffmpeg",
} as WorkerConfig;

const identity = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  jobId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  capability: "image" as const,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = createHash("sha256").update(png).digest("hex");
const generatedKey = `${identity.workspaceId}/image/${identity.jobId}/${identity.attemptId}/original`;
const legacyPngKey = `${identity.workspaceId}/image/${identity.jobId}/${identity.attemptId}.png`;
const provider = {
  baseUrl: new URL("https://provider.example.com"),
  credential: "test",
  signal: new AbortController().signal,
};

function fakeClient(send: (command: unknown) => Promise<unknown>): S3Client {
  return { send } as unknown as S3Client;
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
}

test("recoverMaterialized accepts verified canonical HEAD metadata", async () => {
  const keys: string[] = [];
  const storage = new ObjectStorage(config, fakeClient(async (command) => {
    assert.ok(command instanceof HeadObjectCommand);
    const key = command.input.Key!;
    keys.push(key);
    if (key !== generatedKey) throw notFound();
    return { Metadata: { sha256 }, ContentLength: png.length, ContentType: "image/png; charset=binary" };
  }));

  assert.deepEqual(await storage.recoverMaterialized(identity), {
    objectKey: generatedKey,
    mime: "image/png",
    bytes: BigInt(png.length),
    sha256,
    kind: "image",
  });
  assert.deepEqual(keys, [generatedKey]);
});

test("recoverMaterialized reads one verified legacy extension key", async () => {
  const keys: string[] = [];
  const storage = new ObjectStorage(config, fakeClient(async (command) => {
    assert.ok(command instanceof HeadObjectCommand);
    const key = command.input.Key!;
    keys.push(key);
    if (key !== legacyPngKey) throw notFound();
    return { Metadata: { sha256 }, ContentLength: png.length, ContentType: "image/png" };
  }));

  assert.deepEqual(await storage.recoverMaterialized(identity), {
    objectKey: legacyPngKey,
    mime: "image/png",
    bytes: BigInt(png.length),
    sha256,
    kind: "image",
  });
  assert.equal(keys.length, 6);
});

test("recoverMaterialized rejects malformed or wrong-kind HEAD evidence", async () => {
  for (const response of [
    { Metadata: { sha256: "invalid" }, ContentLength: png.length, ContentType: "image/png" },
    { Metadata: { sha256 }, ContentType: "image/png" },
    { Metadata: { sha256 }, ContentLength: 0, ContentType: "image/png" },
    { Metadata: { sha256 }, ContentLength: -1, ContentType: "image/png" },
    { Metadata: { sha256 }, ContentLength: 1.5, ContentType: "image/png" },
    { Metadata: { sha256 }, ContentLength: config.MAX_MEDIA_BYTES + 1, ContentType: "image/png" },
    { Metadata: { sha256 }, ContentLength: png.length },
    { Metadata: { sha256 }, ContentLength: png.length, ContentType: "video/mp4" },
  ]) {
    const storage = new ObjectStorage(config, fakeClient(async (command) => {
      assert.ok(command instanceof HeadObjectCommand);
      if (command.input.Key !== generatedKey) throw notFound();
      return response;
    }));
    await assert.rejects(
      storage.recoverMaterialized(identity),
      /without valid immutable media evidence/,
    );
  }
});

test("legacy extension recovery rejects a different same-kind MIME", async () => {
  const legacyJpegKey = `${identity.workspaceId}/image/${identity.jobId}/${identity.attemptId}.jpg`;
  const storage = new ObjectStorage(config, fakeClient(async (command) => {
    assert.ok(command instanceof HeadObjectCommand);
    if (command.input.Key === generatedKey) throw notFound();
    if (command.input.Key === legacyJpegKey) {
      return { Metadata: { sha256 }, ContentLength: png.length, ContentType: "image/png" };
    }
    throw notFound();
  }));
  await assert.rejects(
    storage.recoverMaterialized(identity),
    /without valid immutable media evidence/,
  );
});

test("recoverMaterialized returns undefined after all 404 candidates and stops on an operational failure", async () => {
  let calls = 0;
  const missing = new ObjectStorage(config, fakeClient(async () => { calls += 1; throw notFound(); }));
  assert.equal(await missing.recoverMaterialized(identity), undefined);
  assert.equal(calls, 6);

  const unavailable = Object.assign(new Error("storage unavailable"), { $metadata: { httpStatusCode: 503 } });
  calls = 0;
  const failing = new ObjectStorage(config, fakeClient(async () => { calls += 1; throw unavailable; }));
  await assert.rejects(failing.recoverMaterialized(identity), (error) => error === unavailable);
  assert.equal(calls, 1);
});

test("a 412 replay recovers only the exact object written by the same attempt", async () => {
  const commands: unknown[] = [];
  const storage = new ObjectStorage(config, fakeClient(async (command) => {
    commands.push(command);
    if (command instanceof PutObjectCommand) {
      throw Object.assign(new Error("already exists"), { $metadata: { httpStatusCode: 412 } });
    }
    assert.ok(command instanceof HeadObjectCommand);
    return { Metadata: { sha256 }, ContentLength: png.length, ContentType: "image/png" };
  }));

  const result = await storage.materialize(
    new URL(`data:image/png;base64,${png.toString("base64")}`),
    identity,
    provider,
  );
  assert.deepEqual(result, { objectKey: generatedKey, mime: "image/png", bytes: BigInt(png.length), sha256, kind: "image" });
  assert.equal(commands.length, 2);
  assert.equal((commands[0] as PutObjectCommand).input.IfNoneMatch, "*");
});

test("a 412 collision with different content is rejected instead of being settled", async () => {
  const storage = new ObjectStorage(config, fakeClient(async (command) => {
    if (command instanceof PutObjectCommand) {
      throw Object.assign(new Error("already exists"), { name: "PreconditionFailed" });
    }
    assert.ok(command instanceof HeadObjectCommand);
    return { Metadata: { sha256 }, ContentLength: png.length, ContentType: "image/gif" };
  }));

  await assert.rejects(
    storage.materialize(
      new URL(`data:image/png;base64,${png.toString("base64")}`),
      identity,
      provider,
    ),
    /does not match the expected media/,
  );
});
