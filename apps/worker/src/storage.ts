import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { secureFetch, validateMediaFile } from "@infinite-canvas/domain";

import type { WorkerConfig } from "./config.js";
import type { MaterializedAsset } from "./types.js";

const extensions: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function hasExpectedSignature(mime: string, chunk: Buffer): boolean {
  if (mime === "image/jpeg") return chunk[0] === 0xff && chunk[1] === 0xd8;
  if (mime === "image/png")
    return chunk
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/gif")
    return chunk.subarray(0, 3).toString("ascii") === "GIF";
  if (mime === "image/webp")
    return (
      chunk.subarray(0, 4).toString("ascii") === "RIFF" &&
      chunk.subarray(8, 12).toString("ascii") === "WEBP"
    );
  if (mime === "video/mp4")
    return chunk.subarray(4, 8).toString("ascii") === "ftyp";
  if (mime === "video/webm")
    return chunk.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return (
    mime === "image/avif" &&
    chunk.subarray(4, 12).toString("ascii").includes("ftyp")
  );
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "$metadata" in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
    : undefined;
}

export class ObjectStorage {
  readonly #client: S3Client;

  constructor(private readonly config: WorkerConfig) {
    this.#client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async signedReferenceUrl(objectKey: string): Promise<URL> {
    const value = await getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
      { expiresIn: 900 },
    );
    return new URL(value);
  }

  trustedOrigin(): string {
    return new URL(this.config.S3_ENDPOINT).origin;
  }

  async readObject(objectKey: string): Promise<Uint8Array> {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
    );
    if (!result.Body) throw new Error(`Object has no body: ${objectKey}`);
    const value = await result.Body.transformToByteArray();
    if (value.byteLength > this.config.MAX_MEDIA_BYTES)
      throw new Error("Object exceeds configured size limit");
    return value;
  }

  async putImportObject(
    objectKey: string,
    body: Uint8Array,
    mime: string,
  ): Promise<void> {
    if (body.byteLength > this.config.MAX_MEDIA_BYTES)
      throw new Error("Import object exceeds configured size limit");
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: objectKey,
        Body: body,
        ContentType: mime,
      }),
    );
  }

  async recoverMaterialized(identity: {
    workspaceId: string;
    jobId: string;
    attemptId: string;
    capability: "image" | "video";
  }): Promise<MaterializedAsset | undefined> {
    const candidates = Object.entries(extensions).filter(([mime]) =>
      mime.startsWith(`${identity.capability}/`),
    );
    for (const [mime, extension] of candidates) {
      const objectKey = `${identity.workspaceId}/${identity.capability}/${identity.jobId}/${identity.attemptId}.${extension}`;
      try {
        const recovered = await this.headGeneratedObject(
          objectKey,
          mime,
          identity.capability,
        );
        if (recovered) return recovered;
      } catch (error) {
        if (httpStatus(error) !== 404) throw error;
      }
    }
    return undefined;
  }

  async materialize(
    source: URL,
    identity: {
      workspaceId: string;
      jobId: string;
      attemptId: string;
      capability: "image" | "video";
    },
    provider: { baseUrl: URL; credential: string; signal: AbortSignal },
  ): Promise<MaterializedAsset> {
    if (source.protocol === "data:")
      return this.materializeDataUrl(source, identity, provider.signal);
    const sameProvider = source.origin === provider.baseUrl.origin;
    const response = await secureFetch(
      source,
      {
        ...(sameProvider
          ? { headers: { Authorization: `Bearer ${provider.credential}` } }
          : {}),
        signal: provider.signal,
      },
      { maxRedirects: 5, timeoutMs: 120_000 },
    );
    if (!response.ok || !response.body)
      throw new Error(`Media download failed with HTTP ${response.status}`);

    const mime =
      response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ??
      "";
    const extension = extensions[mime];
    if (!extension || !mime.startsWith(`${identity.capability}/`))
      throw new Error(`Unsupported media MIME type: ${mime || "missing"}`);
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(declaredBytes) &&
      declaredBytes > this.config.MAX_MEDIA_BYTES
    )
      throw new Error("Media exceeds configured size limit");

    const directory = await mkdtemp(
      join(tmpdir(), "infinite-canvas-provider-"),
    );
    const mediaPath = join(directory, "asset.bin");
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      let header = Buffer.alloc(0);
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (header.length < 32)
            header = Buffer.concat([
              header,
              chunk.subarray(0, 32 - header.length),
            ]);
          bytes += chunk.length;
          if (bytes > this.config.MAX_MEDIA_BYTES)
            return callback(new Error("Media exceeds configured size limit"));
          hash.update(chunk);
          callback(null, chunk);
        },
        flush: (callback) => {
          if (bytes === 0) return callback(new Error("Media body is empty"));
          if (!hasExpectedSignature(mime, header))
            return callback(
              new Error("Media content does not match its MIME type"),
            );
          callback();
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        meter,
        createWriteStream(mediaPath, { flags: "wx" }),
      );
      await this.validateFile(mediaPath, mime, identity.capability);
      const objectKey = `${identity.workspaceId}/${identity.capability}/${identity.jobId}/${identity.attemptId}.${extension}`;
      const sha256 = hash.digest("hex");
      return await this.putGeneratedObject(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: objectKey,
          Body: createReadStream(mediaPath),
          ContentLength: bytes,
          ContentType: mime,
          Metadata: { sha256 },
          IfNoneMatch: "*",
        }),
        {
          objectKey,
          mime,
          bytes: BigInt(bytes),
          sha256,
          kind: identity.capability,
        },
        provider.signal,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async materializeDataUrl(
    source: URL,
    identity: {
      workspaceId: string;
      jobId: string;
      attemptId: string;
      capability: "image" | "video";
    },
    signal: AbortSignal,
  ): Promise<MaterializedAsset> {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(source.toString());
    if (!match?.[1] || !match[2])
      throw new Error("Only base64 media data URLs are supported");
    const mime = match[1].toLowerCase();
    const extension = extensions[mime];
    if (!extension || !mime.startsWith(`${identity.capability}/`))
      throw new Error(`Unsupported media MIME type: ${mime}`);
    if (Math.floor((match[2].length * 3) / 4) > this.config.MAX_MEDIA_BYTES)
      throw new Error("Media exceeds configured size limit");
    const body = Buffer.from(match[2], "base64");
    if (body.length > this.config.MAX_MEDIA_BYTES)
      throw new Error("Media exceeds configured size limit");
    if (body.length === 0) throw new Error("Media body is empty");
    if (!hasExpectedSignature(mime, body))
      throw new Error("Media content does not match its MIME type");
    const directory = await mkdtemp(
      join(tmpdir(), "infinite-canvas-data-url-"),
    );
    const mediaPath = join(directory, "asset.bin");
    try {
      await writeFile(mediaPath, body, { flag: "wx" });
      await this.validateFile(mediaPath, mime, identity.capability);
      const objectKey = `${identity.workspaceId}/${identity.capability}/${identity.jobId}/${identity.attemptId}.${extension}`;
      const sha256 = createHash("sha256").update(body).digest("hex");
      return await this.putGeneratedObject(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: objectKey,
          Body: createReadStream(mediaPath),
          ContentLength: body.length,
          ContentType: mime,
          Metadata: { sha256 },
          IfNoneMatch: "*",
        }),
        {
          objectKey,
          mime,
          bytes: BigInt(body.length),
          sha256,
          kind: identity.capability,
        },
        signal,
      );
    } finally {
      body.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async putGeneratedObject(
    command: PutObjectCommand,
    expected: MaterializedAsset,
    signal: AbortSignal,
  ): Promise<MaterializedAsset> {
    try {
      await this.#client.send(command, { abortSignal: signal });
      return expected;
    } catch (error) {
      if (
        httpStatus(error) !== 412 &&
        !(error instanceof Error && error.name === "PreconditionFailed")
      )
        throw error;
      const existing = await this.headGeneratedObject(
        expected.objectKey,
        expected.mime,
        expected.kind,
      );
      if (!existing)
        throw new Error(
          "Generated object precondition failed but the existing object could not be verified",
        );
      return existing;
    }
  }

  private async headGeneratedObject(
    objectKey: string,
    fallbackMime: string,
    kind: "image" | "video",
  ): Promise<MaterializedAsset | undefined> {
    const head = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
    );
    const sha256 = head.Metadata?.sha256;
    if (
      !sha256 ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof head.ContentLength !== "number"
    )
      return undefined;
    const mime =
      head.ContentType?.split(";", 1)[0]?.toLowerCase() || fallbackMime;
    if (!mime.startsWith(`${kind}/`)) return undefined;
    return { objectKey, mime, bytes: BigInt(head.ContentLength), sha256, kind };
  }

  private async validateFile(
    path: string,
    mime: string,
    kind: "image" | "video",
  ): Promise<void> {
    await validateMediaFile({
      path,
      mime,
      kind,
      maxImagePixels: this.config.MAX_IMAGE_PIXELS,
      maxDurationSeconds: this.config.MAX_MEDIA_DURATION_SECONDS,
      ffprobePath: this.config.FFPROBE_PATH,
      ffmpegPath: this.config.FFMPEG_PATH,
    });
  }
}
