import { createGenerationBatchRequestSchema, type ActiveGenerationJobProjection, type GenerationBatchSnapshot, type GenerationJobProjection } from "@infinite-canvas/contracts";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { completeCloudUpload, createCloudUploadIntent, getCloudAssetStatus, getCloudAssetUrl, sha256Hex } from "@/services/api/cloud-assets";
import { createCloudGenerationBatch, getCloudGenerationBatch, getCloudGenerationBatchResilient, listCloudModels, resolveCloudGenerationBatch, resolveCloudGenerationBatchResilient, subscribeCloudEvents } from "@/services/api/cloud-generation";
import { clearCloudUploadRetryKey, getOrCreateCloudUploadRetryKey, rotateCloudUploadRetryKey } from "@/services/api/cloud-upload-retry";
import { getImageBlob, uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

import { ActiveGenerationWatchRegistry, CloudGenerationWakeChannel, runCloudGenerationEventPump, waitForCloudGenerationCursorScan } from "./cloud-generation-watch-core";
import { resumeCloudImageBatchesCore } from "./cloud-generation-recovery-drivers";
import { aggregateCloudImageStatus, mergeCloudImageJobStates } from "./cloud-image-state-core";

type SetNodes = (updater: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => void;
const activeBatches = new ActiveGenerationWatchRegistry();

function newerCursor(current: string, candidate: string): string {
    return BigInt(candidate) > BigInt(current) ? candidate : current;
}
const MAX_MATERIALIZATION_ATTEMPTS = 6;

function markMaterializationError(rootId: string, slotId: string, message: string, setNodes: SetNodes): void {
    setNodes((nodes) =>
        nodes.map((node) => {
            if (node.id !== rootId) return node;
            const images = node.metadata?.images?.map((image) => (image.id === slotId ? { ...image, status: "error" as const, errorDetails: message } : image));
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    status: images?.some((image) => image.status === "success") ? "success" : "error",
                    images,
                },
            };
        }),
    );
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason;
}

function waitForAbortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

async function referenceBlob(reference: ReferenceImage, signal?: AbortSignal): Promise<Blob> {
    const stored = reference.storageKey ? await getImageBlob(reference.storageKey) : null;
    throwIfAborted(signal);
    if (stored) return stored;
    const response = await fetch(reference.dataUrl, { signal });
    if (!response.ok) throw new Error("Could not read a reference image");
    return response.blob();
}

export async function uploadCloudImageReference(reference: ReferenceImage, signal?: AbortSignal): Promise<string> {
    const blob = await referenceBlob(reference, signal);
    const sha256 = await sha256Hex(blob);
    throwIfAborted(signal);
    const request = {
        kind: "image" as const,
        mime: blob.type || reference.type || "image/png",
        bytes: String(blob.size),
        sha256,
        filename: reference.name || `${reference.id}.png`,
    };
    let intent = await createCloudUploadIntent(request, `asset-upload:${sha256}`, signal);
    if (intent.status === "rejected") {
        throwIfAborted(signal);
        intent = await createCloudUploadIntent(request, getOrCreateCloudUploadRetryKey(sha256), signal);
        if (intent.status === "rejected") {
            rotateCloudUploadRetryKey(sha256);
            throw new Error("Reference upload was rejected");
        }
    }
    if (intent.status === "ready") {
        clearCloudUploadRetryKey(sha256);
        return intent.assetId;
    }
    if (intent.status === "uploading") {
        const uploaded = await fetch(intent.signedUrl!, {
            method: "PUT",
            headers: { "Content-Type": blob.type || reference.type || "image/png", "x-upsert": "false" },
            body: blob,
            signal,
        });
        if (!uploaded.ok && uploaded.status !== 409) throw new Error(`Reference upload failed with HTTP ${uploaded.status}`);
        const completion = await completeCloudUpload(intent.assetId, signal);
        if (completion.status === "ready") {
            clearCloudUploadRetryKey(sha256);
            return intent.assetId;
        }
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const current = await getCloudAssetStatus(intent.assetId, signal);
        if (current.status === "ready") {
            clearCloudUploadRetryKey(sha256);
            return intent.assetId;
        }
        if (current.status === "rejected") {
            rotateCloudUploadRetryKey(sha256);
            throw new Error("Reference upload was rejected");
        }
        await waitForAbortableDelay(1000, signal);
    }
    throw new Error("Reference upload verification timed out");
}

function updateJobs(rootId: string, jobs: readonly GenerationJobProjection[], setNodes: SetNodes): void {
    setNodes((nodes) =>
        nodes.map((node) => {
            if (node.id !== rootId) return node;
            const images = mergeCloudImageJobStates(node.metadata?.images || [], jobs);
            return { ...node, metadata: { ...node.metadata, cloudBatchId: jobs[0]?.batchId || node.metadata?.cloudBatchId, cloudIdempotencyKey: undefined, images, status: aggregateCloudImageStatus(images) } };
        }),
    );
}

async function materializeImageJob(rootId: string, job: GenerationJobProjection, setNodes: SetNodes, signal: AbortSignal): Promise<void> {
    if (job.status !== "succeeded") throw new Error("Generated job is not ready for materialization");
    if (!job.assetId) throw new Error("Generated asset metadata is incomplete");
    const signed = await getCloudAssetUrl(job.assetId);
    const response = await fetch(signed.signedUrl, { signal });
    if (!response.ok) throw new Error(`Generated asset download failed with HTTP ${response.status}`);
    const uploaded = await uploadImage(await response.blob(), { signal });
    const imageSize = fitNodeSize(uploaded.width, uploaded.height, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
    setNodes((nodes) =>
        nodes.map((node) => {
            if (node.id !== rootId) return node;
            const item: CanvasNodeImage = {
                id: job.slotId,
                status: "success",
                content: uploaded.url,
                storageKey: uploaded.storageKey,
                naturalWidth: uploaded.width,
                naturalHeight: uploaded.height,
                bytes: uploaded.bytes,
                mimeType: uploaded.mimeType,
                cloud: { batchId: job.batchId, jobId: job.jobId, slotId: job.slotId, jobVersion: job.jobVersion, attemptId: job.attemptId, attemptNo: job.attemptNo, serverStatus: job.status, assetId: job.assetId },
            };
            const images = node.metadata?.images?.map((image) => (image.id === job.slotId ? item : image)) || [];
            if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images, status: "success" } };
            const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
            return {
                ...node,
                ...imageSize,
                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                metadata: {
                    ...node.metadata,
                    images,
                    status: "success",
                    primaryImageId: job.slotId,
                    content: item.content,
                    storageKey: item.storageKey,
                    naturalWidth: item.naturalWidth,
                    naturalHeight: item.naturalHeight,
                    bytes: item.bytes,
                    mimeType: item.mimeType,
                },
            };
        }),
    );
}

async function materializeSucceeded(rootId: string, snapshot: GenerationBatchSnapshot, setNodes: SetNodes, completed: Set<string>, failures: Map<string, number>, signal: AbortSignal): Promise<boolean> {
    let allMaterialized = true;
    for (const job of snapshot.jobs) {
        if (job.status !== "succeeded" || completed.has(job.jobId)) continue;
        try {
            await materializeImageJob(rootId, job, setNodes, signal);
        } catch (error) {
            if (signal.aborted) throw error;
            const attempts = (failures.get(job.jobId) ?? 0) + 1;
            failures.set(job.jobId, attempts);
            if (attempts >= MAX_MATERIALIZATION_ATTEMPTS) {
                markMaterializationError(rootId, job.slotId, job.assetId ? "Generated asset could not be downloaded" : "Generated asset metadata is incomplete", setNodes);
                completed.add(job.jobId);
            } else {
                allMaterialized = false;
            }
            continue;
        }
        completed.add(job.jobId);
    }
    return allMaterialized;
}

export async function rematerializeCloudImageJob(batchId: string, jobId: string, rootId: string, setNodes: SetNodes, signal: AbortSignal): Promise<void> {
    const snapshot = await getCloudGenerationBatchResilient(batchId, signal);
    const job = snapshot.jobs.find((candidate) => candidate.jobId === jobId);
    if (!job) throw new Error("Generated image slot no longer exists");
    updateJobs(rootId, snapshot.jobs, setNodes);
    try {
        await materializeImageJob(rootId, job, setNodes, signal);
    } catch (error) {
        if (!signal.aborted) markMaterializationError(rootId, job.slotId, error instanceof Error ? error.message : "Generated asset could not be downloaded", setNodes);
        throw error;
    }
}

export async function watchCloudImageBatch(batchId: string, rootId: string, setNodes: SetNodes, signal: AbortSignal): Promise<GenerationBatchSnapshot | null> {
    const releaseBatch = activeBatches.acquire(batchId, signal);
    if (!releaseBatch) return null;
    const streamController = new AbortController();
    const stopStream = () => streamController.abort(signal.reason);
    signal.addEventListener("abort", stopStream, { once: true });
    const wake = new CloudGenerationWakeChannel();
    let cursor = "0";
    const completed = new Set<string>();
    const materializationFailures = new Map<string, number>();
    void runCloudGenerationEventPump({
        signal: streamController.signal,
        initialCursor: cursor,
        loadSnapshot: (eventSignal) => getCloudGenerationBatch(batchId, eventSignal),
        subscribe: ({ projectId, cursor: eventCursor, signal: eventSignal, onEventSequence }) =>
            subscribeCloudEvents({
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
            updateJobs(rootId, snapshot.jobs, setNodes);
            const materialized = await materializeSucceeded(rootId, snapshot, setNodes, completed, materializationFailures, signal);
            if (materialized && snapshot.jobs.every((job) => ["succeeded", "failed", "canceled", "outcome_unknown"].includes(job.status))) return snapshot;
            await waitForCloudGenerationCursorScan(wake, signal);
        }
    } finally {
        streamController.abort();
        signal.removeEventListener("abort", stopStream);
        releaseBatch();
    }
}

export async function runCloudImageGeneration(options: {
    remoteProjectId: string;
    projectVersion: number;
    rootId: string;
    imageIds: string[];
    prompt: string;
    size?: string;
    parameters?: Record<string, string | number | boolean | null>;
    references: ReferenceImage[];
    idempotencyKey: string;
    setNodes: SetNodes;
    signal: AbortSignal;
}) {
    const models = await listCloudModels("image", options.signal);
    const model = models[0];
    if (!model) throw new Error("No active cloud image model is configured");
    const referenceAssetIds = await Promise.all(options.references.map((reference) => uploadCloudImageReference(reference, options.signal)));
    throwIfAborted(options.signal);
    const request = createGenerationBatchRequestSchema.parse({
        projectId: options.remoteProjectId,
        kind: "image",
        count: options.imageIds.length,
        target: { nodeId: options.rootId, slotIds: options.imageIds },
        modelConfigId: model.modelConfigId,
        input: { prompt: options.prompt, ...(options.size ? { size: options.size } : {}), referenceAssetIds, parameters: options.parameters || {} },
        projectVersion: options.projectVersion,
    });
    let created;
    try {
        created = await createCloudGenerationBatch(request, options.idempotencyKey, options.signal);
    } catch {
        throwIfAborted(options.signal);
        try {
            // The business POST is protected by the same persisted idempotency key; retrying it cannot create another batch.
            created = await createCloudGenerationBatch(request, options.idempotencyKey, options.signal);
        } catch {
            throwIfAborted(options.signal);
            created = await resolveCloudGenerationBatch(options.remoteProjectId, options.idempotencyKey, options.signal);
        }
    }
    updateJobs(options.rootId, created.jobs, options.setNodes);
    return watchCloudImageBatch(created.batchId, options.rootId, options.setNodes, options.signal);
}

export async function resumeCloudImageBatches(nodes: readonly CanvasNodeData[], setNodes: SetNodes, signal: AbortSignal, remoteProjectId?: string, authoritativeJobs: readonly ActiveGenerationJobProjection[] = []): Promise<void> {
    return resumeCloudImageBatchesCore({
        nodes,
        signal,
        ...(remoteProjectId ? { remoteProjectId } : {}),
        authoritativeJobs,
        updateJobs: (nodeId, jobs) => updateJobs(nodeId, jobs, setNodes),
        watchBatch: (batchId, nodeId, watchSignal) => watchCloudImageBatch(batchId, nodeId, setNodes, watchSignal),
        resolveBatch: resolveCloudGenerationBatchResilient,
        hasBlob: async (storageKey) => Boolean(await getImageBlob(storageKey)),
    });
}
