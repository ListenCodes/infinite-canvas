import type { ActiveGenerationJobProjection } from "@infinite-canvas/contracts";

import type { CanvasNodeData } from "@/types/canvas";

type SetNodes = (updater: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => void;
type ResumeDriver = (
    nodes: readonly CanvasNodeData[],
    setNodes: SetNodes,
    signal: AbortSignal,
    remoteProjectId?: string,
    authoritativeJobs?: readonly ActiveGenerationJobProjection[],
) => Promise<void>;

export async function resumeCloudProjectGenerations(options: {
    nodes: readonly CanvasNodeData[];
    setNodes: SetNodes;
    signal: AbortSignal;
    remoteProjectId?: string;
    getActiveJobs: (projectId: string, signal: AbortSignal) => Promise<{ jobs: readonly ActiveGenerationJobProjection[] }>;
    resumeImages: ResumeDriver;
    resumeVideos: ResumeDriver;
}): Promise<void> {
    let authoritativeJobs: readonly ActiveGenerationJobProjection[] = [];
    if (options.remoteProjectId) {
        try {
            authoritativeJobs = (await options.getActiveJobs(options.remoteProjectId, options.signal)).jobs;
        } catch {
            if (options.signal.aborted) return;
            // Persisted local batch metadata remains the offline recovery fallback.
        }
    }
    if (options.signal.aborted) return;
    await Promise.all([
        options.resumeImages(options.nodes, options.setNodes, options.signal, options.remoteProjectId, authoritativeJobs),
        options.resumeVideos(options.nodes, options.setNodes, options.signal, options.remoteProjectId, authoritativeJobs),
    ]);
}
