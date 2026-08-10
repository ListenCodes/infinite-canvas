import { createProjectRequestSchema, projectProjectionSchema, updateProjectRequestSchema, type CreateProjectRequest, type UpdateProjectRequest } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";
import type { CloudRequestIdentity } from "./cloud-request-identity";

export function listCloudProjects(signal?: AbortSignal, expectedIdentity?: CloudRequestIdentity) {
    return cloudFetch("/v1/projects", projectProjectionSchema.array(), { signal, expectedIdentity });
}
export function getCloudProject(projectId: string) {
    return cloudFetch(`/v1/projects/${projectId}`, projectProjectionSchema);
}
export function createCloudProject(input: CreateProjectRequest, idempotencyKey: string, signal?: AbortSignal) {
    return cloudFetch("/v1/projects", projectProjectionSchema, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(createProjectRequestSchema.parse(input)),
        signal,
    });
}
export function updateCloudProject(projectId: string, input: UpdateProjectRequest, signal?: AbortSignal) {
    return cloudFetch(`/v1/projects/${projectId}`, projectProjectionSchema, { method: "PUT", body: JSON.stringify(updateProjectRequestSchema.parse(input)), signal });
}
