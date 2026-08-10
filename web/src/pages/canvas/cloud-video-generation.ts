import { createGenerationBatchRequestSchema, type ActiveGenerationJobProjection, type GenerationBatchSnapshot, type GenerationJobProjection } from "@infinite-canvas/contracts";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { getCloudAssetUrl } from "@/services/api/cloud-assets";
import { createCloudGenerationBatch, getCloudGenerationBatch, getCloudGenerationBatchResilient, listCloudModels, resolveCloudGenerationBatch, resolveCloudGenerationBatchResilient, subscribeCloudEvents } from "@/services/api/cloud-generation";
import { getMediaBlob, uploadMediaFile } from "@/services/file-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

import { uploadCloudImageReference } from "./cloud-image-generation";
import { ActiveGenerationWatchRegistry, CloudGenerationWakeChannel, runCloudGenerationEventPump, waitForCloudGenerationCursorScan } from "./cloud-generation-watch-core";
import { resumeCloudVideoBatchesCore } from "./cloud-generation-recovery-drivers";

type SetNodes = (updater: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => void;
const activeBatches = new ActiveGenerationWatchRegistry();

function newerCursor(current: string, candidate: string): string {
    return BigInt(candidate) > BigInt(current) ? candidate : current;
}
const MAX_MATERIALIZATION_ATTEMPTS = 6;

function markMaterializationError(nodeId: string, message: string, setNodes: SetNodes): void {
    setNodes((nodes) =>
        nodes.map((node) =>
            node.id === nodeId
                ? {
                      ...node,
                      metadata: { ...node.metadata, status: "error", errorDetails: message },
                  }
                : node,
        ),
    );
}

function updateJob(nodeId: string, job: GenerationJobProjection, setNodes: SetNodes): void {
    setNodes((nodes) =>
        nodes.map((node) =>
            node.id === nodeId
                ? {
                      ...node,
                      metadata: {
                          ...node.metadata,
                          status: job.status === "failed" || job.status === "canceled" || job.status === "outcome_unknown" ? "error" : job.status === "succeeded" && node.metadata?.content ? "success" : "loading",
                          errorDetails: job.status === "failed" || job.status === "canceled" || job.status === "outcome_unknown" ? job.errorMessage || job.errorCode || job.status : undefined,
                          cloudBatchId: job.batchId,
                          cloudSlotId: job.slotId,
                          cloudJob: {
                              ...node.metadata?.cloudJob,
                              batchId: job.batchId,
                              jobId: job.jobId,
                              slotId: job.slotId,
                              jobVersion: job.jobVersion,
                              attemptId: job.attemptId,
                              attemptNo: job.attemptNo,
                              serverStatus: job.status,
                              ...(job.assetId ? { assetId: job.assetId } : {}),
                              retryIdempotencyKey: node.metadata?.cloudJob?.attemptId === job.attemptId ? node.metadata.cloudJob.retryIdempotencyKey : undefined,
                          },
                          cloudIdempotencyKey: undefined,
                      },
                  }
                : node,
        ),
    );
}

async function materializeVideo(nodeId: string, job: GenerationJobProjection, setNodes: SetNodes, signal: AbortSignal): Promise<boolean> {
    if (job.status !== "succeeded") return true;
    if (!job.assetId) return false;
    try {
        const signed = await getCloudAssetUrl(job.assetId);
        const response = await fetch(signed.signedUrl, { signal });
        if (!response.ok) throw new Error(`Generated video download failed with HTTP ${response.status}`);
        const video = await uploadMediaFile(await response.blob(), "video");
        const defaults = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const size = fitNodeSize(video.width || defaults.width, video.height || defaults.height, defaults.width, defaults.height);
        setNodes((nodes) =>
            nodes.map((node) => {
                if (node.id !== nodeId) return node;
                const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                return {
                    ...node,
                    ...size,
                    position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
                    metadata: { ...node.metadata, ...videoMetadata(video), cloudJob: { ...node.metadata!.cloudJob!, assetId: job.assetId, serverStatus: "succeeded" } },
                };
            }),
        );
        return true;
    } catch (error) {
        if (signal.aborted) throw error;
        return false;
    }
}

export async function watchCloudVideoBatch(batchId: string, nodeId: string, setNodes: SetNodes, signal: AbortSignal): Promise<GenerationBatchSnapshot | null> {
    const releaseBatch = activeBatches.acquire(batchId, signal);
    if (!releaseBatch) return null;
    const stream = new AbortController();
    const stop = () => stream.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    const wake = new CloudGenerationWakeChannel();
    let cursor = "0";
    let materializationFailures = 0;
    void runCloudGenerationEventPump({
        signal: stream.signal,
        initialCursor: cursor,
        loadSnapshot: (eventSignal) => getCloudGenerationBatch(batchId, eventSignal),
        subscribe: ({ projectId, cursor: eventCursor, signal: eventSignal, onEventSequence }) => subscribeCloudEvents({
            projectId,
            cursor: eventCursor,
            signal: eventSignal,
            onEvent: (event) => onEventSequence(event.sequence),
        }),
        onEvent: () => wake.notify(),
    });
    try {
        for (;;) {
            if (signal.aborted) throw signal.reason;
            const snapshot = await getCloudGenerationBatchResilient(batchId, signal);
            if (signal.aborted) throw signal.reason;
            cursor = newerCursor(cursor, snapshot.eventCursor);
            const job = snapshot.jobs[0];
            if (!job) throw new Error("Video batch has no job");
            updateJob(nodeId, job, setNodes);
            if (job.status === "succeeded" && !job.assetId) {
                markMaterializationError(nodeId, "Generated asset metadata is incomplete", setNodes);
                return snapshot;
            }
            const materialized = await materializeVideo(nodeId, job, setNodes, signal);
            if (job.status === "succeeded" && !materialized) {
                materializationFailures += 1;
                if (materializationFailures >= MAX_MATERIALIZATION_ATTEMPTS) {
                    markMaterializationError(nodeId, "Generated asset could not be downloaded", setNodes);
                    return snapshot;
                }
            }
            if (materialized && ["succeeded", "failed", "canceled", "outcome_unknown"].includes(job.status)) return snapshot;
            await waitForCloudGenerationCursorScan(wake, signal);
        }
    } finally {
        stream.abort();
        signal.removeEventListener("abort", stop);
        releaseBatch();
    }
}

export async function runCloudVideoGeneration(options: {
    remoteProjectId: string;
    projectVersion: number;
    nodeId: string;
    slotId: string;
    prompt: string;
    size?: string;
    durationSeconds?: number;
    parameters?: Record<string, string | number | boolean | null>;
    references: ReferenceImage[];
    idempotencyKey: string;
    setNodes: SetNodes;
    signal: AbortSignal;
}) {
    const models = await listCloudModels("video");
    const model = models[0];
    if (!model) throw new Error("No active cloud video model is configured");
    const referenceAssetIds = await Promise.all(options.references.map(uploadCloudImageReference));
    const request = createGenerationBatchRequestSchema.parse({
        projectId: options.remoteProjectId,
        kind: "video",
        count: 1,
        target: { nodeId: options.nodeId, slotIds: [options.slotId] },
        modelConfigId: model.modelConfigId,
        input: { prompt: options.prompt, ...(options.size ? { size: options.size } : {}), ...(options.durationSeconds ? { durationSeconds: options.durationSeconds } : {}), referenceAssetIds, parameters: options.parameters || {} },
        projectVersion: options.projectVersion,
    });
    let created;
    try {
        created = await createCloudGenerationBatch(request, options.idempotencyKey);
    } catch {
        try {
            created = await createCloudGenerationBatch(request, options.idempotencyKey);
        } catch {
            created = await resolveCloudGenerationBatch(options.remoteProjectId, options.idempotencyKey);
        }
    }
    const job = created.jobs[0];
    if (job) updateJob(options.nodeId, job, options.setNodes);
    return watchCloudVideoBatch(created.batchId, options.nodeId, options.setNodes, options.signal);
}

export async function resumeCloudVideoBatches(
    nodes: readonly CanvasNodeData[],
    setNodes: SetNodes,
    signal: AbortSignal,
    remoteProjectId?: string,
    authoritativeJobs: readonly ActiveGenerationJobProjection[] = [],
): Promise<void> {
    return resumeCloudVideoBatchesCore({
        nodes,
        videoNodeType: CanvasNodeType.Video,
        signal,
        ...(remoteProjectId ? { remoteProjectId } : {}),
        authoritativeJobs,
        updateJob: (nodeId, job) => updateJob(nodeId, job, setNodes),
        watchBatch: (batchId, nodeId, watchSignal) => watchCloudVideoBatch(batchId, nodeId, setNodes, watchSignal),
        resolveBatch: resolveCloudGenerationBatchResilient,
        hasBlob: async (storageKey) => Boolean(await getMediaBlob(storageKey)),
    });
}
