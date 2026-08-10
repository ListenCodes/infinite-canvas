import { assetCompleteResponseSchema, assetSignedUrlResponseSchema, assetStatusResponseSchema, assetUploadIntentRequestSchema, assetUploadIntentResponseSchema } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";

export async function sha256Hex(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
export function createCloudUploadIntent(input: unknown, idempotencyKey: string) {
    return cloudFetch("/v1/assets/upload-intents", assetUploadIntentResponseSchema, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(assetUploadIntentRequestSchema.parse(input)),
    });
}
export function completeCloudUpload(assetId: string) {
    return cloudFetch(`/v1/assets/${assetId}/complete`, assetCompleteResponseSchema, { method: "POST" });
}
export function getCloudAssetStatus(assetId: string) {
    return cloudFetch(`/v1/assets/${assetId}`, assetStatusResponseSchema);
}
export function getCloudAssetUrl(assetId: string) {
    return cloudFetch(`/v1/assets/${assetId}/signed-url`, assetSignedUrlResponseSchema);
}
