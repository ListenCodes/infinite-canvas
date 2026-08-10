import { localDataImportResponseSchema } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";

export function createCloudImport(archive: Blob, signal?: AbortSignal) {
    const body = new FormData();
    body.append("file", archive, "infinite-canvas-local-export.zip");
    return cloudFetch("/v1/imports", localDataImportResponseSchema, {
        method: "POST",
        body,
        signal,
    });
}

export function getCloudImport(importId: string, signal?: AbortSignal) {
    return cloudFetch(`/v1/imports/${importId}`, localDataImportResponseSchema, { signal });
}
