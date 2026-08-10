export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    slotId?: string;
    controller: AbortController;
};

export type CanceledCanvasGenerationRequest = {
    key: string;
    request: CanvasGenerationRequest;
};

export function replaceCanvasGenerationRequest(
    requests: Map<string, CanvasGenerationRequest>,
    key: string,
    request: CanvasGenerationRequest,
): CanceledCanvasGenerationRequest[] {
    const previous = requests.get(key);
    const canceled: CanceledCanvasGenerationRequest[] = [];
    if (previous && previous.controller !== request.controller) {
        previous.controller.abort();
        for (const [candidateKey, candidate] of requests) {
            if (candidate.controller !== previous.controller) continue;
            canceled.push({ key: candidateKey, request: candidate });
            requests.delete(candidateKey);
        }
    }
    requests.set(key, request);
    return canceled;
}

export function finishCanvasGenerationRequest(
    requests: Map<string, CanvasGenerationRequest>,
    key: string,
    controller: AbortController,
): void {
    if (requests.get(key)?.controller === controller) requests.delete(key);
}
