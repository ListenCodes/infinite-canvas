type GenerationImageState = {
    status?: string;
    errorDetails?: string;
    [key: string]: unknown;
};

type GenerationNodeState = {
    metadata?: {
        status?: string;
        content?: string;
        errorDetails?: string;
        images?: GenerationImageState[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

export function settleCanceledImageGeneration<T extends GenerationNodeState>(node: T, canceledMessage: string): T {
    if (node.metadata?.status !== "loading") return node;
    const hasSuccess = Boolean(node.metadata.content) || Boolean(node.metadata.images?.some((image) => image.status === "success"));
    return {
        ...node,
        metadata: {
            ...node.metadata,
            status: hasSuccess ? "success" : "idle",
            errorDetails: hasSuccess ? undefined : canceledMessage,
            images: node.metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "error", errorDetails: canceledMessage } : image)),
        },
    };
}

export function settleCanceledGeneration<T extends GenerationNodeState>(node: T, canceledMessage: string, isImageNode: boolean): T {
    if (node.metadata?.status !== "loading") return node;
    if (isImageNode) return settleCanceledImageGeneration(node, canceledMessage);
    return {
        ...node,
        metadata: { ...node.metadata, status: "idle", errorDetails: undefined },
    };
}
