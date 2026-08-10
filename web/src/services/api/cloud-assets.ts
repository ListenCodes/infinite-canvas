import { assetCompleteResponseSchema, assetSignedUrlResponseSchema, assetStatusResponseSchema, assetUploadIntentRequestSchema, assetUploadIntentResponseSchema } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";
import type { CloudRequestIdentity } from "./cloud-request-identity";

export async function sha256Hex(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
export function createCloudUploadIntent(input: unknown, idempotencyKey: string, signal?: AbortSignal) {
    return cloudFetch("/v1/assets/upload-intents", assetUploadIntentResponseSchema, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(assetUploadIntentRequestSchema.parse(input)),
        signal,
    });
}
export function completeCloudUpload(assetId: string, signal?: AbortSignal) {
    return cloudFetch(`/v1/assets/${assetId}/complete`, assetCompleteResponseSchema, { method: "POST", signal });
}
export function getCloudAssetStatus(assetId: string, signal?: AbortSignal) {
    return cloudFetch(`/v1/assets/${assetId}`, assetStatusResponseSchema, { signal });
}
export function getCloudAssetUrl(assetId: string, signal?: AbortSignal, expectedIdentity?: CloudRequestIdentity) {
    return cloudFetch(`/v1/assets/${assetId}/signed-url`, assetSignedUrlResponseSchema, { signal, expectedIdentity });
}
