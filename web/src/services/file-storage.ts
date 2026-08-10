import localforage from "localforage";
import { nanoid } from "nanoid";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const MEDIA_METADATA_TIMEOUT_MS = 5000;

export async function uploadMediaFile(input: string | Blob, prefix = "file", signal?: AbortSignal): Promise<UploadedFile> {
    signal?.throwIfAborted();
    const blob = typeof input === "string" ? await (await fetch(input, { signal })).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    try {
        signal?.throwIfAborted();
        await store.setItem(storageKey, blob);
        signal?.throwIfAborted();
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(url, signal) : blob.type.startsWith("audio/") ? await readAudioMeta(url, signal) : {};
        signal?.throwIfAborted();
        return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
    } catch (error) {
        await deleteStoredMedia([storageKey]);
        throw error;
    }
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string, signal?: AbortSignal) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const video = document.createElement("video");
        let settled = false;
        const done = (error?: unknown) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onerror = null;
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        const onAbort = () => done(signal?.reason ?? new DOMException("Media upload aborted", "AbortError"));
        const timer = window.setTimeout(done, MEDIA_METADATA_TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        video.preload = "metadata";
        video.onloadedmetadata = () => done();
        video.onerror = () => done();
        video.src = url;
        video.load();
    });
}

function readAudioMeta(url: string, signal?: AbortSignal) {
    return new Promise<{ durationMs?: number }>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const audio = document.createElement("audio");
        let settled = false;
        const done = (error?: unknown) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            audio.onloadedmetadata = null;
            audio.onerror = null;
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const onAbort = () => done(signal?.reason ?? new DOMException("Media upload aborted", "AbortError"));
        const timer = window.setTimeout(done, MEDIA_METADATA_TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        audio.preload = "metadata";
        audio.onloadedmetadata = () => done();
        audio.onerror = () => done();
        audio.src = url;
        audio.load();
    });
}
