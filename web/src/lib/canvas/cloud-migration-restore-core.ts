export interface CloudMigrationRollbackProject {
    sourceId: string;
    title: string;
    document: Record<string, unknown>;
}

export interface CloudMigrationRollbackAsset {
    sourceId: string;
    sha256: string;
    bytes: number;
    mime: string;
}

interface RollbackAssetBase {
    id: string;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
}

export type CloudMigrationRollbackLocalAsset =
    | (RollbackAssetBase & { kind: "text"; data: { content: string } })
    | (RollbackAssetBase & { kind: "image"; data: { dataUrl: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string } })
    | (RollbackAssetBase & { kind: "video"; data: { url: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string } });

export function restoreCloudMigrationLocalAssets<Existing extends { id: string }>(
    archived: readonly CloudMigrationRollbackLocalAsset[],
    restoredUrls: ReadonlyMap<string, string>,
    existing: readonly Existing[],
): Array<CloudMigrationRollbackLocalAsset | Existing> {
    const restored = archived.map((asset): CloudMigrationRollbackLocalAsset => {
        if (asset.kind === "text") return asset;
        const url = restoredUrls.get(asset.data.storageKey);
        if (!url) throw new Error("migration asset object is missing");
        if (asset.kind === "image") return { ...asset, coverUrl: asset.coverUrl || url, data: { ...asset.data, dataUrl: url } };
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:") ? url : asset.coverUrl,
            data: { ...asset.data, url },
        };
    });
    const restoredIds = new Set(restored.map((asset) => asset.id));
    return [...restored, ...existing.filter((asset) => !restoredIds.has(asset.id))];
}

function parseLocalAsset(value: unknown): CloudMigrationRollbackLocalAsset {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cloud migration rollback local asset is invalid");
    const candidate = value as Record<string, unknown>;
    const data = candidate.data as Record<string, unknown> | undefined;
    const baseValid =
        typeof candidate.id === "string" && candidate.id.length > 0 &&
        typeof candidate.title === "string" && typeof candidate.coverUrl === "string" &&
        Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === "string") &&
        typeof candidate.createdAt === "string" && typeof candidate.updatedAt === "string" &&
        (candidate.source === undefined || typeof candidate.source === "string") &&
        (candidate.note === undefined || typeof candidate.note === "string") &&
        (candidate.metadata === undefined || (candidate.metadata !== null && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)));
    if (!baseValid || !data) throw new Error("Cloud migration rollback local asset is invalid");
    if (candidate.kind === "text" && typeof data.content === "string") return value as CloudMigrationRollbackLocalAsset;
    const mimeType = typeof data.mimeType === "string" ? data.mimeType : "";
    const mediaValid =
        typeof data.storageKey === "string" && /^[a-z][a-z0-9_-]*:.+$/i.test(data.storageKey.trim()) &&
        typeof data.width === "number" && Number.isFinite(data.width) && data.width >= 0 &&
        typeof data.height === "number" && Number.isFinite(data.height) && data.height >= 0 &&
        typeof data.bytes === "number" && Number.isSafeInteger(data.bytes) && data.bytes >= 0 && mimeType.length > 0;
    if (candidate.kind === "image" && mediaValid && mimeType.startsWith("image/") && typeof data.dataUrl === "string") return value as CloudMigrationRollbackLocalAsset;
    if (candidate.kind === "video" && mediaValid && mimeType.startsWith("video/") && typeof data.url === "string") return value as CloudMigrationRollbackLocalAsset;
    throw new Error("Cloud migration rollback local asset is invalid");
}

export function parseCloudMigrationRollbackData(
    manifestValue: unknown,
    projectsValue: unknown,
    assetsValue: unknown,
    localAssetsValue: unknown = [],
): { projects: CloudMigrationRollbackProject[]; assets: CloudMigrationRollbackAsset[]; localAssets: CloudMigrationRollbackLocalAsset[] } {
    if (!manifestValue || typeof manifestValue !== "object") throw new Error("Cloud migration rollback manifest is invalid");
    const manifest = manifestValue as Record<string, unknown>;
    const counts = manifest.counts as Record<string, unknown> | undefined;
    if (manifest.format !== "infinite-canvas-local-export" || manifest.schemaVersion !== 1 || !counts) {
        throw new Error("Cloud migration rollback manifest is invalid");
    }
    if (!Array.isArray(projectsValue) || !Array.isArray(assetsValue)) {
        throw new Error("Cloud migration rollback data is invalid");
    }
    if (!Array.isArray(localAssetsValue)) throw new Error("Cloud migration rollback local assets are invalid");
    const projects = projectsValue.map((value) => {
        if (!value || typeof value !== "object") throw new Error("Cloud migration rollback project is invalid");
        const candidate = value as Record<string, unknown>;
        const documentJson = candidate.documentJson as Record<string, unknown> | undefined;
        if (
            typeof candidate.sourceId !== "string" ||
            typeof candidate.title !== "string" ||
            !documentJson ||
            documentJson.schemaVersion !== 1 ||
            !documentJson.document ||
            typeof documentJson.document !== "object" ||
            Array.isArray(documentJson.document)
        ) {
            throw new Error("Cloud migration rollback project is invalid");
        }
        return { sourceId: candidate.sourceId, title: candidate.title, document: documentJson.document as Record<string, unknown> };
    });
    const assets = assetsValue.map((value) => {
        if (!value || typeof value !== "object") throw new Error("Cloud migration rollback asset is invalid");
        const candidate = value as Record<string, unknown>;
        if (
            typeof candidate.sourceId !== "string" ||
            !/^[a-f0-9]{64}$/.test(typeof candidate.sha256 === "string" ? candidate.sha256 : "") ||
            !/^\d+$/.test(typeof candidate.bytes === "string" ? candidate.bytes : "") ||
            typeof candidate.mime !== "string" ||
            !/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(candidate.mime)
        ) {
            throw new Error("Cloud migration rollback asset is invalid");
        }
        const bytes = Number(candidate.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Cloud migration rollback asset is invalid");
        return { sourceId: candidate.sourceId, sha256: candidate.sha256 as string, bytes, mime: candidate.mime };
    });
    if (counts.projects !== projects.length || counts.assets !== assets.length) {
        throw new Error("Cloud migration rollback counts do not match the archive");
    }
    return { projects, assets, localAssets: localAssetsValue.map(parseLocalAsset) };
}
