import type { ActiveGenerationJobProjection, GenerationBatchSnapshot, GenerationJobProjection } from "@infinite-canvas/contracts";

interface ImageRecoveryNode {
    id: string;
    metadata?: {
        cloudBatchId?: string;
        cloudIdempotencyKey?: string;
        images?: Array<{
            content?: string;
            storageKey?: string;
            cloud?: { retryIdempotencyKey?: string; serverStatus: string };
        }>;
    };
}

interface VideoRecoveryNode {
    id: string;
    type: string;
    metadata?: {
        cloudBatchId?: string;
        cloudIdempotencyKey?: string;
        content?: string;
        storageKey?: string;
        cloudJob?: { retryIdempotencyKey?: string; serverStatus: string };
    };
}

const terminalWithoutMaterialization = new Set(["failed", "canceled", "outcome_unknown"]);
const terminal = new Set(["succeeded", ...terminalWithoutMaterialization]);

export function cloudImageRetryMode(image: { status: string; cloud?: { serverStatus: string } }): "attempt" | "materialize" | null {
    if (!image.cloud) return null;
    if (["failed", "canceled"].includes(image.cloud.serverStatus)) return "attempt";
    if (image.cloud.serverStatus === "succeeded" && image.status === "error") return "materialize";
    return null;
}

export async function resumeCloudImageBatchesCore(options: {
    nodes: readonly ImageRecoveryNode[];
    signal: AbortSignal;
    remoteProjectId?: string;
    authoritativeJobs?: readonly ActiveGenerationJobProjection[];
    updateJobs: (nodeId: string, jobs: readonly GenerationJobProjection[]) => void;
    watchBatch: (batchId: string, nodeId: string, signal: AbortSignal) => Promise<unknown>;
    resolveBatch: (projectId: string, idempotencyKey: string, signal: AbortSignal) => Promise<GenerationBatchSnapshot>;
    hasBlob: (storageKey: string) => Promise<boolean>;
}): Promise<void> {
    const restoredBatches = new Map<string, { nodeId: string; jobs: ActiveGenerationJobProjection[] }>();
    for (const job of options.authoritativeJobs ?? []) {
        if (job.capability !== "image") continue;
        const group = restoredBatches.get(job.batchId) ?? { nodeId: job.targetNodeId, jobs: [] };
        group.jobs.push(job);
        restoredBatches.set(job.batchId, group);
    }
    for (const [batchId, group] of restoredBatches) {
        options.updateJobs(group.nodeId, group.jobs);
        if (group.jobs.some((job) => !terminalWithoutMaterialization.has(job.status))) {
            void options.watchBatch(batchId, group.nodeId, options.signal).catch(() => undefined);
        }
    }
    for (const node of options.nodes) {
        if (options.signal.aborted) return;
        let batchId = node.metadata?.cloudBatchId;
        let resolved = false;
        if (!batchId && options.remoteProjectId && node.metadata?.cloudIdempotencyKey) {
            try {
                const snapshot = await options.resolveBatch(options.remoteProjectId, node.metadata.cloudIdempotencyKey, options.signal);
                if (options.signal.aborted) return;
                batchId = snapshot.batchId;
                resolved = true;
                options.updateJobs(node.id, snapshot.jobs);
            } catch {
                if (options.signal.aborted) return;
                continue;
            }
        }
        if (batchId && resolved) {
            void options.watchBatch(batchId, node.id, options.signal).catch(() => undefined);
            continue;
        }
        let recoverable = false;
        for (const image of node.metadata?.images ?? []) {
            if (!image.cloud) continue;
            if (image.cloud.retryIdempotencyKey || !terminal.has(image.cloud.serverStatus)) {
                recoverable = true;
                break;
            }
            if (image.cloud.serverStatus === "succeeded" && (!image.content || !image.storageKey || !(await options.hasBlob(image.storageKey)))) {
                recoverable = true;
                break;
            }
        }
        if (batchId && recoverable) void options.watchBatch(batchId, node.id, options.signal).catch(() => undefined);
    }
}

export async function resumeCloudVideoBatchesCore(options: {
    nodes: readonly VideoRecoveryNode[];
    videoNodeType: string;
    signal: AbortSignal;
    remoteProjectId?: string;
    authoritativeJobs?: readonly ActiveGenerationJobProjection[];
    updateJob: (nodeId: string, job: GenerationJobProjection) => void;
    watchBatch: (batchId: string, nodeId: string, signal: AbortSignal) => Promise<unknown>;
    resolveBatch: (projectId: string, idempotencyKey: string, signal: AbortSignal) => Promise<GenerationBatchSnapshot>;
    hasBlob: (storageKey: string) => Promise<boolean>;
}): Promise<void> {
    for (const job of options.authoritativeJobs ?? []) {
        if (job.capability !== "video") continue;
        options.updateJob(job.targetNodeId, job);
        if (!terminalWithoutMaterialization.has(job.status)) {
            void options.watchBatch(job.batchId, job.targetNodeId, options.signal).catch(() => undefined);
        }
    }
    for (const node of options.nodes) {
        if (options.signal.aborted) return;
        if (node.type !== options.videoNodeType) continue;
        let batchId = node.metadata?.cloudBatchId;
        let serverStatus = node.metadata?.cloudJob?.serverStatus;
        if ((!batchId || !serverStatus) && options.remoteProjectId && node.metadata?.cloudIdempotencyKey) {
            try {
                const snapshot = await options.resolveBatch(options.remoteProjectId, node.metadata.cloudIdempotencyKey, options.signal);
                if (options.signal.aborted) return;
                batchId = snapshot.batchId;
                const resolvedJob = snapshot.jobs[0];
                serverStatus = resolvedJob?.status;
                if (resolvedJob) options.updateJob(node.id, resolvedJob);
            } catch {
                if (options.signal.aborted) return;
                continue;
            }
        }
        if (!batchId || !serverStatus) continue;
        const recoverable =
            Boolean(node.metadata?.cloudJob?.retryIdempotencyKey) ||
            !terminal.has(serverStatus) ||
            (serverStatus === "succeeded" && (!node.metadata?.content || !node.metadata.storageKey || !(await options.hasBlob(node.metadata.storageKey))));
        if (recoverable) void options.watchBatch(batchId, node.id, options.signal).catch(() => undefined);
    }
}
