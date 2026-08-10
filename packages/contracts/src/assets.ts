import { z } from "zod";

import { assetIdSchema } from "./ids.js";

export const assetKindSchema = z.enum(["image", "video", "audio", "import"]);
export const assetUploadStatusSchema = z.enum(["uploading", "verifying", "ready", "rejected"]);
const uploadMimeSchema = z.enum([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
  "video/mp4", "video/webm",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4",
  "application/zip", "application/x-zip-compressed",
]);
export const assetUploadIntentRequestSchema = z.object({
  kind: assetKindSchema,
  mime: uploadMimeSchema,
  bytes: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().trim().min(1).max(200),
}).superRefine((value, context) => {
  const allowed = value.kind === "image" ? value.mime.startsWith("image/")
    : value.kind === "video" ? value.mime.startsWith("video/")
    : value.kind === "audio" ? value.mime.startsWith("audio/")
    : value.mime === "application/zip" || value.mime === "application/x-zip-compressed";
  if (!allowed) context.addIssue({ code: "custom", path: ["mime"], message: "MIME type does not match asset kind" });
});
export const assetUploadIntentResponseSchema = z.object({
  assetId: assetIdSchema,
  objectKey: z.string().min(1),
  status: assetUploadStatusSchema,
  signedUrl: z.url().optional(),
  token: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.status === "uploading" && (!value.signedUrl || !value.token)) {
    context.addIssue({ code: "custom", message: "Uploading intents require a signed URL and token" });
  }
});
export const assetStatusResponseSchema = z.object({
  assetId: assetIdSchema,
  status: assetUploadStatusSchema,
});
export const assetCompleteResponseSchema = assetStatusResponseSchema.refine(
  (value) => value.status === "verifying" || value.status === "ready",
  { message: "Complete response must be verifying or ready" },
);
export const assetSignedUrlResponseSchema = z.object({
  assetId: assetIdSchema,
  signedUrl: z.url(),
  expiresIn: z.number().int().positive(),
});

export type AssetUploadIntentRequest = z.infer<typeof assetUploadIntentRequestSchema>;
export type AssetUploadIntentResponse = z.infer<typeof assetUploadIntentResponseSchema>;
export type AssetStatusResponse = z.infer<typeof assetStatusResponseSchema>;
