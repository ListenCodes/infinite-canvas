import { createProjectRequestSchema, projectProjectionSchema, updateProjectRequestSchema, type CreateProjectRequest, type UpdateProjectRequest } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";

export function listCloudProjects() {
    return cloudFetch("/v1/projects", projectProjectionSchema.array());
}
export function getCloudProject(projectId: string) {
    return cloudFetch(`/v1/projects/${projectId}`, projectProjectionSchema);
}
export function createCloudProject(input: CreateProjectRequest, idempotencyKey: string) {
    return cloudFetch("/v1/projects", projectProjectionSchema, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(createProjectRequestSchema.parse(input)),
    });
}
export function updateCloudProject(projectId: string, input: UpdateProjectRequest) {
    return cloudFetch(`/v1/projects/${projectId}`, projectProjectionSchema, { method: "PUT", body: JSON.stringify(updateProjectRequestSchema.parse(input)) });
}
