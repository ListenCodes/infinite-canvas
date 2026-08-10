import {
    activeJobsSnapshotSchema,
    cancelGenerationJobResponseSchema,
    createGenerationBatchRequestSchema,
    createGenerationBatchResponseSchema,
    generationBatchSnapshotSchema,
    generationJobProjectionSchema,
    generationTaskListResponseSchema,
    modelListResponseSchema,
    type CreateGenerationBatchRequest,
    type GenerationEvent,
} from "@infinite-canvas/contracts";

import { authorizedFetch, CloudApiError, cloudFetch } from "./cloud-client";
import { buildCloudEventRequest, GenerationEventDecoder } from "./cloud-event-stream";

export function listCloudModels(capability?: "image" | "video", signal?: AbortSignal) {
    return cloudFetch(`/v1/model-configs${capability ? `?capability=${capability}` : ""}`, modelListResponseSchema, { signal });
}
export function createCloudGenerationBatch(input: CreateGenerationBatchRequest, idempotencyKey: string, signal?: AbortSignal) {
    return cloudFetch("/v1/generation-batches", createGenerationBatchResponseSchema, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(createGenerationBatchRequestSchema.parse(input)),
        signal,
    });
}
export function getCloudGenerationBatch(batchId: string, signal?: AbortSignal) {
    return cloudFetch(`/v1/generation-batches/${batchId}`, generationBatchSnapshotSchema, { signal });
}
export function getCloudProjectActiveJobs(projectId: string, signal?: AbortSignal) {
    return cloudFetch(`/v1/projects/${projectId}/active-jobs`, activeJobsSnapshotSchema, { signal });
}

function waitForCloudRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export async function getCloudGenerationBatchResilient(batchId: string, signal: AbortSignal) {
    let delayMs = 500;
    for (;;) {
        if (signal.aborted) throw signal.reason;
        try {
            return await getCloudGenerationBatch(batchId, signal);
        } catch (error) {
            if (error instanceof CloudApiError && !error.detail.retryable) throw error;
            await waitForCloudRetry(delayMs, signal);
            delayMs = Math.min(delayMs * 2, 5000);
        }
    }
}
export function resolveCloudGenerationBatch(projectId: string, idempotencyKey: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ projectId, idempotencyKey });
    return cloudFetch(`/v1/generation-batches/resolve?${query}`, generationBatchSnapshotSchema, { signal });
}
export async function resolveCloudGenerationBatchResilient(projectId: string, idempotencyKey: string, signal: AbortSignal) {
    let delayMs = 500;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        if (signal.aborted) throw signal.reason;
        try {
            return await resolveCloudGenerationBatch(projectId, idempotencyKey, signal);
        } catch (error) {
            const transientNotFound = error instanceof CloudApiError && error.status === 404;
            if (!transientNotFound && error instanceof CloudApiError && !error.detail.retryable) throw error;
            if (attempt === 7) throw error;
            await waitForCloudRetry(delayMs, signal);
            delayMs = Math.min(delayMs * 2, 5000);
        }
    }
    throw new Error("Generation batch resolution exhausted");
}
export function listCloudGenerationJobs(workspaceId?: string, before?: string) {
    const query = new URLSearchParams({ limit: "100" });
    if (workspaceId) query.set("workspaceId", workspaceId);
    if (before) query.set("before", before);
    return cloudFetch(`/v1/generation-jobs?${query}`, generationTaskListResponseSchema);
}
export function retryCloudGenerationJob(jobId: string, idempotencyKey: string, signal?: AbortSignal) {
    return cloudFetch(`/v1/generation-jobs/${jobId}/retry`, generationJobProjectionSchema, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, signal });
}
export function cancelCloudGenerationJob(jobId: string) {
    return cloudFetch(`/v1/generation-jobs/${jobId}/cancel`, cancelGenerationJobResponseSchema, { method: "POST" });
}

export async function subscribeCloudEvents(options: { projectId: string; cursor: string; signal: AbortSignal; onEvent: (event: GenerationEvent) => void }): Promise<void> {
    const request = buildCloudEventRequest(options.projectId, options.cursor);
    const response = await authorizedFetch(request.path, {
        headers: request.headers,
        signal: options.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Event stream failed with HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const decoder = new GenerationEventDecoder(options.cursor);
    while (!options.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const event of decoder.push(value)) options.onEvent(event);
    }
}
