import type { CanvasDocument } from "@infinite-canvas/contracts";

import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import {
    annotateMigrationDocument,
    assertDurableMigrationAssets,
    assertMigrationSourcesPresent,
    collectMigrationStorageKeys,
    type MigrationSourceObject,
} from "./cloud-migration-export-core";

type MediaKind = "image" | "video" | "audio";

interface ExportedAsset {
    sourceId: string;
    sha256: string;
    bytes: string;
    mime: string;
    filename: string;
    kind: MediaKind;
}

export interface CloudMigrationArchive {
    archive: Blob;
    counts: { projects: number; assets: number; objects: number };
}

function mediaKind(mime: string): MediaKind | null {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return null;
}

function safeFilename(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "asset";
}

async function sha256(value: Blob | Uint8Array): Promise<string> {
    const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : Uint8Array.from(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

async function sourceObject(storageKey: string): Promise<Blob | null> {
    return storageKey.startsWith("image:")
        ? getImageBlob(storageKey)
        : getMediaBlob(storageKey);
}

export async function createCloudMigrationArchive(
    projects: readonly CanvasProject[],
    assets: readonly Asset[],
    clientExportId: string,
): Promise<CloudMigrationArchive> {
    assertDurableMigrationAssets(assets);
    const sources = new Map<string, MigrationSourceObject>();
    const storageKeys = new Set<string>();
    projects.forEach((project) => collectMigrationStorageKeys(project, storageKeys));
    for (const asset of assets) {
        if (asset.kind === "text") continue;
        if (asset.data.storageKey) storageKeys.add(asset.data.storageKey);
    }
    await Promise.all(
        Array.from(storageKeys, async (storageKey) => {
            const blob = await sourceObject(storageKey);
            if (blob) sources.set(storageKey, { blob, filename: storageKey });
        }),
    );
    assertMigrationSourcesPresent(storageKeys, sources);
    for (const asset of assets) {
        if (asset.kind === "text" || !asset.data.storageKey) continue;
        const source = sources.get(asset.data.storageKey);
        if (source) sources.set(asset.id, { blob: source.blob, filename: asset.title || asset.id });
    }

    const exportedAssets: ExportedAsset[] = [];
    const objects = new Map<string, Blob>();
    for (const [sourceId, source] of sources) {
        const kind = mediaKind(source.blob.type);
        if (!kind) throw new Error(`Unsupported local media type: ${source.blob.type || "unknown"}`);
        const digest = await sha256(source.blob);
        objects.set(digest, source.blob);
        exportedAssets.push({
            sourceId,
            sha256: digest,
            bytes: String(source.blob.size),
            mime: source.blob.type,
            filename: safeFilename(source.filename),
            kind,
        });
    }

    const exportedProjects = projects.map((project) => {
        const { cloud: _cloud, ...localDocument } = project;
        const documentJson: CanvasDocument = {
            schemaVersion: 1,
            localProjectId: project.id,
            document: annotateMigrationDocument(localDocument, sources) as Record<string, unknown>,
        };
        return { sourceId: project.id, title: project.title, documentJson };
    });
    const encoder = new TextEncoder();
    const projectBytes = encoder.encode(JSON.stringify(exportedProjects));
    const assetBytes = encoder.encode(JSON.stringify(exportedAssets));
    const localAssetBytes = encoder.encode(JSON.stringify(assets.map((asset) => {
        if (asset.kind === "text") return asset;
        const source = sources.get(asset.data.storageKey!);
        if (!source) throw new Error("Cloud migration cannot continue because a local asset object is missing");
        const localUrl = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:") ? "" : asset.coverUrl,
            data: {
                ...asset.data,
                ...(asset.kind === "image" ? { dataUrl: localUrl.startsWith("blob:") || localUrl.startsWith("data:") ? "" : localUrl } : { url: localUrl.startsWith("blob:") || localUrl.startsWith("data:") ? "" : localUrl }),
            },
        };
    })));
    const files: { path: string; bytes: string; sha256: string; mediaType: string }[] = [
        { path: "data/projects.json", bytes: String(projectBytes.byteLength), sha256: await sha256(projectBytes), mediaType: "application/json" },
        { path: "data/assets.json", bytes: String(assetBytes.byteLength), sha256: await sha256(assetBytes), mediaType: "application/json" },
        { path: "data/local-assets.json", bytes: String(localAssetBytes.byteLength), sha256: await sha256(localAssetBytes), mediaType: "application/json" },
    ];
    for (const [digest, blob] of objects) {
        files.push({ path: `objects/${digest}`, bytes: String(blob.size), sha256: digest, mediaType: blob.type });
    }
    const counts = { projects: exportedProjects.length, assets: exportedAssets.length, objects: objects.size };
    const manifest = {
        format: "infinite-canvas-local-export",
        schemaVersion: 1,
        clientExportId,
        createdAt: new Date().toISOString(),
        counts,
        files,
    };
    const archive = await createZip([
        { name: "manifest.json", data: JSON.stringify(manifest) },
        { name: "data/projects.json", data: projectBytes },
        { name: "data/assets.json", data: assetBytes },
        { name: "data/local-assets.json", data: localAssetBytes },
        ...Array.from(objects, ([digest, blob]) => ({ name: `objects/${digest}`, data: blob })),
    ]);
    return { archive, counts };
}
