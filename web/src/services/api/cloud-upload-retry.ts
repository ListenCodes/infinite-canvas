const STORAGE_KEY = "infinite-canvas:cloud-upload-retries:v1";

interface RetryStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function browserStorage(): RetryStorage | undefined {
    return typeof localStorage === "undefined" ? undefined : localStorage;
}

function read(storage: RetryStorage | undefined): Record<string, string> {
    if (!storage) return {};
    try {
        const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
        return {};
    }
}

function write(storage: RetryStorage | undefined, value: Record<string, string>): void {
    storage?.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function getOrCreateCloudUploadRetryKey(
    sha256: string,
    createId: () => string = () => crypto.randomUUID(),
    storage: RetryStorage | undefined = browserStorage(),
): string {
    const retries = read(storage);
    if (retries[sha256]) return retries[sha256];
    const key = `asset-upload:${sha256}:retry:${createId()}`;
    retries[sha256] = key;
    write(storage, retries);
    return key;
}

export function rotateCloudUploadRetryKey(
    sha256: string,
    createId: () => string = () => crypto.randomUUID(),
    storage: RetryStorage | undefined = browserStorage(),
): string {
    const retries = read(storage);
    const key = `asset-upload:${sha256}:retry:${createId()}`;
    retries[sha256] = key;
    write(storage, retries);
    return key;
}

export function clearCloudUploadRetryKey(
    sha256: string,
    storage: RetryStorage | undefined = browserStorage(),
): void {
    const retries = read(storage);
    if (!(sha256 in retries)) return;
    delete retries[sha256];
    write(storage, retries);
}
