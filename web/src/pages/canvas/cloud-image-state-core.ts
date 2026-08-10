import type { GenerationJobProjection } from "@infinite-canvas/contracts";

type ImageStatus = "idle" | "success" | "loading" | "error";

interface ImageJobState {
    id: string;
    status: ImageStatus;
    errorDetails?: string;
    cloud?: {
        batchId: string;
        jobId: string;
        slotId: string;
        jobVersion: number;
        attemptId: string;
        attemptNo: number;
        serverStatus: string;
        progress?: number;
        assetId?: string;
        retryIdempotencyKey?: string;
    };
}

const terminalErrors = new Set(["failed", "canceled", "outcome_unknown"]);

export function mergeCloudImageJobStates<T extends ImageJobState>(images: readonly T[], jobs: readonly GenerationJobProjection[]): T[] {
    const bySlot = new Map(jobs.map((job) => [String(job.slotId), job]));
    return images.map((image) => {
        const job = bySlot.get(image.id);
        if (!job) return image;
        const terminalError = terminalErrors.has(job.status);
        return {
            ...image,
            status: terminalError ? "error" : job.status === "succeeded" ? image.status : "loading",
            errorDetails: terminalError ? job.errorMessage || job.errorCode || job.status : image.errorDetails,
            cloud: {
                ...image.cloud,
                batchId: job.batchId,
                jobId: job.jobId,
                slotId: job.slotId,
                jobVersion: job.jobVersion,
                attemptId: job.attemptId,
                attemptNo: job.attemptNo,
                serverStatus: job.status,
                ...(job.progress !== undefined ? { progress: job.progress } : {}),
                ...(job.assetId ? { assetId: job.assetId } : {}),
                retryIdempotencyKey: image.cloud?.attemptId === job.attemptId ? image.cloud.retryIdempotencyKey : undefined,
            },
        } as T;
    });
}

export function aggregateCloudImageStatus(images: readonly ImageJobState[]): ImageStatus {
    const active = images.some((image) => image.cloud && !["succeeded", "failed", "canceled", "outcome_unknown"].includes(image.cloud.serverStatus));
    if (active) return "loading";
    return images.some((image) => image.status === "success") ? "success" : "error";
}
