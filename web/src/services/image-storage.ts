import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const IMAGE_UPLOAD_TIMEOUT_MS = 30000;

export async function uploadImage(input: string | Blob, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UploadedImage> {
    const storageKey = `image:${nanoid()}`;
    const controller = new AbortController();
    const abort = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Image storage timed out", "TimeoutError")), options?.timeoutMs ?? IMAGE_UPLOAD_TIMEOUT_MS);
    let url = "";
    try {
        throwIfAborted(controller.signal);
        return await raceWithSignal(
            (async () => {
                const blob = typeof input === "string" ? await (await fetch(input, { signal: controller.signal })).blob() : input;
                throwIfAborted(controller.signal);
                await store.setItem(storageKey, blob);
                if (controller.signal.aborted) {
                    await store.removeItem(storageKey);
                    throwAbortReason(controller.signal);
                }
                url = URL.createObjectURL(blob);
                objectUrls.set(storageKey, url);
                const meta = await readImageMeta(url);
                throwIfAborted(controller.signal);
                return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
            })(),
            controller.signal,
        );
    } catch (error) {
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        void store.removeItem(storageKey).catch(() => undefined);
        if (controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError") throw new Error(i18n.t("common.imageStoreTimeout"));
        throw error;
    } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throwAbortReason(signal);
}

function throwAbortReason(signal: AbortSignal): never {
    throw signal.reason || new DOMException("Aborted", "AbortError");
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
