export type VideoStorageInput = { blob?: Blob; url?: string; mimeType?: string };

export type StoredVideoFile = {
    url: string;
    storageKey: string;
    bytes: number;
    mimeType: string;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type VideoStorageWriter = (input: string | Blob, prefix: string, signal?: AbortSignal) => Promise<StoredVideoFile>;

export async function storeGeneratedVideoCore(result: VideoStorageInput, signal: AbortSignal | undefined, upload: VideoStorageWriter): Promise<StoredVideoFile> {
    signal?.throwIfAborted();
    if (result.blob) return upload(result.blob, "video", signal);
    if (result.url) {
        try {
            return await upload(result.url, "video", signal);
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error("Generated video has no playable media");
}
