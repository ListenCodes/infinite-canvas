export interface MigrationSourceObject {
    blob: Blob;
    filename: string;
}

interface MigrationAssetReference {
    kind: string;
    data?: unknown;
}

const ephemeralMediaFields = new Set(["content", "url", "dataUrl", "coverUrl"]);

export function isDurableMigrationStorageKey(value: unknown): value is string {
    return typeof value === "string" && /^[a-z][a-z0-9_-]*:.+$/i.test(value.trim());
}

export function collectMigrationStorageKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    const record = value as Record<string, unknown>;
    if (isDurableMigrationStorageKey(record.storageKey)) keys.add(record.storageKey);
    for (const item of Object.values(record)) {
        if (Array.isArray(item)) item.forEach((child) => collectMigrationStorageKeys(child, keys));
        else collectMigrationStorageKeys(item, keys);
    }
    return keys;
}

export function assertDurableMigrationAssets(assets: readonly MigrationAssetReference[]): void {
    const missing = assets.filter((asset) => {
        if (asset.kind === "text") return false;
        if (!asset.data || typeof asset.data !== "object") return true;
        return !isDurableMigrationStorageKey((asset.data as Record<string, unknown>).storageKey);
    });
    if (missing.length) {
        throw new Error(`Cloud migration cannot continue because ${missing.length} local media assets have no durable storage key`);
    }
}

export function assertMigrationSourcesPresent(
    storageKeys: ReadonlySet<string>,
    sources: ReadonlyMap<string, MigrationSourceObject>,
): void {
    const missing = Array.from(storageKeys).filter((storageKey) => !sources.has(storageKey));
    if (missing.length) {
        throw new Error(`Cloud migration cannot continue because ${missing.length} referenced local media files are missing`);
    }
}

export function annotateMigrationDocument(
    value: unknown,
    sources: ReadonlyMap<string, MigrationSourceObject>,
): unknown {
    if (Array.isArray(value)) return value.map((item) => annotateMigrationDocument(item, sources));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const storageKey = record.storageKey;
    if (typeof storageKey === "string" && !isDurableMigrationStorageKey(storageKey)) {
        throw new Error("Cloud migration cannot continue because a local media storage key is invalid");
    }
    const source = isDurableMigrationStorageKey(storageKey) ? sources.get(storageKey) : undefined;
    if (isDurableMigrationStorageKey(storageKey) && !source) {
        throw new Error("Cloud migration cannot continue because a referenced local media file is missing");
    }
    const sanitized = Object.fromEntries(
        Object.entries(record).map(([key, item]) => {
            if (
                ephemeralMediaFields.has(key) &&
                typeof item === "string" &&
                (item.startsWith("blob:") || item.startsWith("data:"))
            ) {
                if (!source) {
                    throw new Error("Cloud migration cannot continue because ephemeral media has no durable local object");
                }
                return [key, ""];
            }
            return [key, annotateMigrationDocument(item, sources)];
        }),
    );
    if (!source || !isDurableMigrationStorageKey(storageKey)) return sanitized;
    return {
        ...sanitized,
        cloudAssetId: storageKey,
        cloudAssetMime: source.blob.type,
    };
}
