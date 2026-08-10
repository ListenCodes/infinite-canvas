import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { SupabaseClient } from "@supabase/supabase-js";
import { assetUploadIntentRequestSchema } from "@infinite-canvas/contracts";
import { MediaProbeUnavailableError, validateMediaFile } from "@infinite-canvas/domain";

import type { Sql } from "../database.js";
import { setServiceContext, setUserContext } from "../database.js";
import { AppError } from "../errors.js";
import type { IdFactory } from "../ids.js";
import {
  assertIdempotencyKey,
  idempotencyRequestHash,
  type IdempotencyRow,
} from "../request-idempotency.js";

export const uploadIntentSchema = assetUploadIntentRequestSchema;

interface AssetRow {
  id: string;
  workspace_id: string;
  object_key: string;
  mime: string;
  bytes: string;
  sha256: string;
  status: "uploading" | "verifying" | "ready" | "rejected" | "deleted";
  kind: "image" | "video" | "audio" | "import";
  verification_token: string | null;
}

function hasExpectedSignature(mime: string, body: Buffer): boolean {
  if (mime === "image/jpeg") return body[0] === 0xff && body[1] === 0xd8;
  if (mime === "image/png") return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/gif") return body.subarray(0, 3).toString("ascii") === "GIF";
  if (mime === "image/webp") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "image/avif") return body.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(body.subarray(8, 32).toString("ascii"));
  if (mime === "video/mp4") return body.subarray(4, 8).toString("ascii") === "ftyp";
  if (mime === "video/webm") return body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return body.subarray(0, 2).toString("ascii") === "PK";
  if (mime === "audio/mpeg") return body.subarray(0, 3).toString("ascii") === "ID3" || (body.length >= 2 && body[0] === 0xff && (body[1]! & 0xe0) === 0xe0);
  if (mime === "audio/wav" || mime === "audio/x-wav") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WAVE";
  if (mime === "audio/ogg") return body.subarray(0, 4).toString("ascii") === "OggS";
  if (mime === "audio/mp4") return body.subarray(4, 8).toString("ascii") === "ftyp";
  return false;
}

function extension(filename: string): string {
  const value = /\.([a-z0-9]{1,10})$/i.exec(filename)?.[1]?.toLowerCase();
  return value ? `.${value}` : "";
}

export class AssetService {
  constructor(
    private readonly sql: Sql,
    private readonly supabase: SupabaseClient,
    private readonly bucket: string,
    private readonly maxUploadBytes: number,
    private readonly createId: IdFactory,
    private readonly mediaLimits: { maxImagePixels: number; maxDurationSeconds: number; ffprobePath: string; ffmpegPath: string },
  ) {}

  async createUploadIntent(userId: string, rawInput: unknown, idempotencyKey: string) {
    assertIdempotencyKey(idempotencyKey);
    const input = uploadIntentSchema.parse(rawInput);
    const bytes = BigInt(input.bytes);
    if (bytes > BigInt(this.maxUploadBytes)) throw new AppError(413, "asset_too_large", "Asset exceeds the upload size limit");
    const created = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const memberships = await transaction<{ workspace_id: string }[]>`
        select member.workspace_id
        from workspace_members member
        join workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
        join profiles profile on profile.user_id = member.user_id and profile.status = 'active'
        where member.user_id = ${userId} and member.status = 'active' and member.role in ('owner', 'editor')
        order by member.created_at limit 1
      `;
      const workspaceId = memberships[0]?.workspace_id;
      if (!workspaceId) throw new AppError(403, "workspace_write_forbidden", "No writable workspace is available");
      const operation = `asset.upload-intent:${userId}`;
      const requestHash = idempotencyRequestHash({
        kind: input.kind,
        mime: input.mime,
        bytes: input.bytes,
        sha256: input.sha256,
      });
      let requests = await transaction<IdempotencyRow[]>`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values (${this.createId()}, ${workspaceId}, ${operation}, ${idempotencyKey}, ${requestHash}, now() + interval '7 days')
        on conflict (workspace_id, operation, key) do nothing
        returning id, request_hash, status, response_body
      `;
      if (!requests[0]) {
        requests = await transaction<IdempotencyRow[]>`
          select id, request_hash, status, response_body
          from idempotency_requests
          where workspace_id = ${workspaceId} and operation = ${operation} and key = ${idempotencyKey}
          for update
        `;
      }
      const request = requests[0];
      if (!request || request.request_hash !== requestHash) {
        throw new AppError(409, "idempotency_key_conflict", "Idempotency-Key was already used with different asset metadata");
      }
      if (request.status === "completed") {
        const response = request.response_body as { assetId?: unknown; objectKey?: unknown };
        if (typeof response?.assetId !== "string" || typeof response.objectKey !== "string") {
          throw new Error("Stored upload intent response is invalid");
        }
        const assets = await transaction<{ status: AssetRow["status"] }[]>`
          select status from assets where id = ${response.assetId} and workspace_id = ${workspaceId}
        `;
        if (!assets[0]) throw new Error("Stored upload intent asset is missing");
        return { assetId: response.assetId, objectKey: response.objectKey, status: assets[0].status };
      }
      if (request.status !== "processing") {
        throw new AppError(409, "idempotency_request_failed", "The previous upload intent did not complete");
      }
      const assetId = this.createId();
      const objectKey = `${workspaceId}/uploads/${assetId}${extension(input.filename)}`;
      await transaction`
        insert into assets (id, workspace_id, kind, status, object_key, mime, bytes, sha256)
        values (${assetId}, ${workspaceId}, ${input.kind}, 'uploading', ${objectKey}, ${input.mime}, ${input.bytes}::bigint, ${input.sha256})
      `;
      const response = { assetId, objectKey };
      await transaction`
        update idempotency_requests
        set status = 'completed', response_status = 201,
            response_body = ${JSON.stringify(response)}::jsonb, updated_at = now()
        where id = ${request.id}
      `;
      return { ...response, status: "uploading" as const };
    });
    if (created.status !== "uploading")
      return { assetId: created.assetId, objectKey: created.objectKey, status: created.status };
    const { data, error } = await this.supabase.storage.from(this.bucket).createSignedUploadUrl(created.objectKey, { upsert: false });
    if (error) throw new AppError(503, "object_storage_failed", "Could not create an upload URL");
    return { assetId: created.assetId, objectKey: created.objectKey, status: "uploading" as const, signedUrl: data.signedUrl, token: data.token };
  }

  async completeUpload(userId: string, assetId: string) {
    const verificationToken = this.createId();
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      const existing = await transaction<AssetRow[]>`
        select asset.id, asset.workspace_id, asset.object_key, asset.mime, asset.bytes::text, asset.sha256,
               asset.status, asset.kind, asset.verification_token
        from assets asset
        join workspace_members member on member.workspace_id = asset.workspace_id
        join workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
        join profiles profile on profile.user_id = member.user_id and profile.status = 'active'
        where asset.id = ${assetId} and member.user_id = ${userId} and member.status = 'active' and member.role in ('owner', 'editor')
        for update of asset
      `;
      const asset = existing[0];
      if (!asset) return [];
      const claimed = await transaction<{ id: string }[]>`
        update assets set status = 'verifying', verification_token = ${verificationToken}, updated_at = now()
        where id = ${assetId} and (
          status = 'uploading' or (status = 'verifying' and updated_at < now() - interval '5 minutes')
        ) returning id
      `;
      return [{ ...asset, claimed: Boolean(claimed[0]) }];
    });
    const asset = rows[0] as (AssetRow & { claimed: boolean }) | undefined;
    if (!asset) throw new AppError(404, "asset_not_found", "Asset was not found");
    if (asset.status === "ready") return { assetId, status: "ready" };
    if (!asset.claimed && asset.status === "verifying") return { assetId, status: "verifying" as const };
    if (!asset.claimed) throw new AppError(409, "asset_upload_rejected", "Asset upload was rejected and cannot be completed");
    const storage = this.supabase.storage.from(this.bucket);
    try {
      const info = await storage.info(asset.object_key);
      if (info.error) throw new AppError(409, "asset_upload_incomplete", "Uploaded object is not available");
      if (typeof info.data.size !== "number" || BigInt(info.data.size) !== BigInt(asset.bytes)) {
        throw new AppError(422, "asset_size_mismatch", "Uploaded object size does not match the declared size");
      }
      const metadataMime = typeof info.data.metadata?.mimetype === "string" ? info.data.metadata.mimetype : undefined;
      if (!metadataMime || metadataMime.toLowerCase() !== asset.mime.toLowerCase()) throw new AppError(422, "asset_mime_mismatch", "Uploaded object MIME type does not match");
      const signed = await storage.createSignedUrl(asset.object_key, 60);
      if (signed.error) throw new AppError(503, "object_storage_failed", "Could not verify uploaded object");
      const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new AppError(503, "object_storage_failed", "Could not verify uploaded object");
      const directory = await mkdtemp(join(tmpdir(), "infinite-canvas-upload-"));
      const mediaPath = join(directory, "asset.bin");
      const hash = createHash("sha256");
      let bytes = 0;
      let header = Buffer.alloc(0);
      try {
        const meter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            bytes += chunk.length;
            if (bytes > this.maxUploadBytes) return callback(new AppError(413, "asset_too_large", "Asset exceeds the upload size limit"));
            hash.update(chunk);
            if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(mediaPath, { flags: "wx" }));
        if (BigInt(bytes) !== BigInt(asset.bytes)) throw new AppError(422, "asset_size_mismatch", "Uploaded object size does not match the declared size");
        if (!hasExpectedSignature(asset.mime, header)) throw new AppError(422, "asset_signature_mismatch", "Uploaded object content does not match its MIME type");
        if (hash.digest("hex") !== asset.sha256) throw new AppError(422, "asset_checksum_mismatch", "Uploaded object checksum does not match");
        if (asset.kind !== "import") {
          try {
            await validateMediaFile({
              path: mediaPath,
              mime: asset.mime,
              kind: asset.kind,
              maxImagePixels: this.mediaLimits.maxImagePixels,
              maxDurationSeconds: this.mediaLimits.maxDurationSeconds,
              ffprobePath: this.mediaLimits.ffprobePath,
              ffmpegPath: this.mediaLimits.ffmpegPath,
            });
          } catch (error) {
            if (error instanceof MediaProbeUnavailableError) throw new AppError(503, "media_probe_unavailable", "Media validation is temporarily unavailable");
            throw new AppError(422, "asset_decode_failed", "Uploaded media could not be decoded");
          }
        }
        const updated = await this.sql.begin(async (transaction) => {
          await setServiceContext(transaction);
          return transaction<{ id: string }[]>`
            update assets set status = 'ready', verification_token = null, updated_at = now()
            where id = ${assetId} and status = 'verifying' and verification_token = ${verificationToken}
            returning id
          `;
        });
        if (!updated[0]) throw new AppError(409, "asset_state_conflict", "Asset state changed during verification");
        return { assetId, status: "ready" };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      await this.sql.begin(async (transaction) => {
        await setServiceContext(transaction);
        const retryable = !(error instanceof AppError) || error.statusCode >= 500 || error.code === "asset_upload_incomplete";
        await transaction`
          update assets set status = ${retryable ? "uploading" : "rejected"}::asset_status,
            verification_token = null, updated_at = now()
          where id = ${assetId} and status = 'verifying' and verification_token = ${verificationToken}
        `;
      });
      throw error;
    }
  }

  async status(userId: string, assetId: string) {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return transaction<{ status: AssetRow["status"] }[]>`
        select asset.status
        from assets asset
        join workspace_members member on member.workspace_id = asset.workspace_id
        where asset.id = ${assetId} and asset.status <> 'deleted'
          and member.user_id = ${userId} and member.status = 'active'
      `;
    });
    const current = rows[0]?.status;
    if (!current) throw new AppError(404, "asset_not_found", "Asset was not found");
    return { assetId, status: current };
  }

  async signedDownload(userId: string, assetId: string) {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return transaction<{ object_key: string }[]>`
        select asset.object_key
        from assets asset
        join workspace_members member on member.workspace_id = asset.workspace_id
        where asset.id = ${assetId} and asset.status = 'ready'
          and member.user_id = ${userId} and member.status = 'active'
      `;
    });
    const objectKey = rows[0]?.object_key;
    if (!objectKey) throw new AppError(404, "asset_not_found", "Asset was not found");
    const { data, error } = await this.supabase.storage.from(this.bucket).createSignedUrl(objectKey, 900, { download: false });
    if (error) throw new AppError(503, "object_storage_failed", "Could not create a download URL");
    return { assetId, signedUrl: data.signedUrl, expiresIn: 900 };
  }
}
