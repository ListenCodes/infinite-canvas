import { localDataImportResponseSchema } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";

export function createCloudImport(archive: Blob) {
    const body = new FormData();
    body.append("file", archive, "infinite-canvas-local-export.zip");
    return cloudFetch("/v1/imports", localDataImportResponseSchema, {
        method: "POST",
        body,
    });
}

export function getCloudImport(importId: string) {
    return cloudFetch(`/v1/imports/${importId}`, localDataImportResponseSchema);
}
