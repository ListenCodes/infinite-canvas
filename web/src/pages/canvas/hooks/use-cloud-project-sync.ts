import { useCallback, useEffect, useRef } from "react";
import { workspaceIdSchema, type CanvasDocument, type ProjectProjection } from "@infinite-canvas/contracts";

import { CLOUD_BACKEND_CONFIGURED } from "@/constant/runtime-config";
import { CloudApiError } from "@/services/api/cloud-client";
import { getCloudAssetUrl } from "@/services/api/cloud-assets";
import { createCloudProject, listCloudProjects, updateCloudProject } from "@/services/api/cloud-projects";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

function withoutEphemeralUrls<T>(value: T): T {
    if (Array.isArray(value)) return value.map(withoutEphemeralUrls) as T;
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(source).map(([key, item]) => {
        if (key === "content" && typeof item === "string" && (item.startsWith("blob:") || item.startsWith("data:"))) return [key, ""];
        return [key, withoutEphemeralUrls(item)];
    })) as T;
}

export function projectDocument(project: CanvasProject): CanvasDocument {
    const { cloud: _cloud, ...document } = project;
    return { schemaVersion: 1, localProjectId: project.id, document: withoutEphemeralUrls(document) };
}

function hasLocalMediaReference(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record.storageKey === "string" && record.storageKey.includes(":")) return true;
    return Object.values(record).some((item) => Array.isArray(item) ? item.some(hasLocalMediaReference) : hasLocalMediaReference(item));
}

async function hydrateCloudAssets(value: unknown): Promise<unknown> {
    const materialized = new Map<string, Promise<Awaited<ReturnType<typeof uploadImage>> | Awaited<ReturnType<typeof uploadMediaFile>>>>();
    const visit = async (item: unknown): Promise<unknown> => {
        if (Array.isArray(item)) return Promise.all(item.map(visit));
        if (!item || typeof item !== "object") return item;
        const record = item as Record<string, unknown>;
        const hydrated = Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, child]) => [key, await visit(child)])));
        const assetId = record.cloudAssetId;
        const mime = record.cloudAssetMime;
        if (typeof assetId !== "string" || typeof mime !== "string") return hydrated;
        let pending = materialized.get(assetId);
        if (!pending) {
            pending = (async () => {
                const signed = await getCloudAssetUrl(assetId);
                const response = await fetch(signed.signedUrl);
                if (!response.ok) throw new Error(`Cloud asset download failed with HTTP ${response.status}`);
                const blob = await response.blob();
                return mime.startsWith("image/") ? uploadImage(blob) : uploadMediaFile(blob, mime.startsWith("video/") ? "video" : "audio");
            })();
            materialized.set(assetId, pending);
        }
        const local = await pending;
        const url = local.url;
        return {
            ...hydrated,
            ...(Object.hasOwn(record, "content") ? { content: url } : {}),
            ...(Object.hasOwn(record, "url") ? { url } : {}),
            ...(Object.hasOwn(record, "dataUrl") ? { dataUrl: url } : {}),
            ...(Object.hasOwn(record, "coverUrl") ? { coverUrl: url } : {}),
            storageKey: local.storageKey,
            bytes: local.bytes,
            mimeType: local.mimeType,
            ...(mime.startsWith("image/") && "width" in local && Object.hasOwn(record, "naturalWidth") ? { naturalWidth: local.width, naturalHeight: local.height } : {}),
        };
    };
    return visit(value);
}

async function fromProjection(remote: ProjectProjection): Promise<CanvasProject | null> {
    const source = await hydrateCloudAssets(remote.documentJson.document) as Partial<CanvasProject>;
    if (!Array.isArray(source.nodes) || !Array.isArray(source.connections)) return null;
    return {
        id: remote.documentJson.localProjectId,
        title: remote.title,
        createdAt: source.createdAt || remote.createdAt,
        updatedAt: remote.updatedAt,
        nodes: source.nodes,
        connections: source.connections,
        chatSessions: source.chatSessions || [],
        activeChatId: source.activeChatId || null,
        backgroundMode: source.backgroundMode || "lines",
        showImageInfo: source.showImageInfo || false,
        viewport: source.viewport || { x: 0, y: 0, k: 1 },
        cloud: { projectId: remote.id, version: remote.version, workspaceId: remote.workspaceId, userId: "" },
    };
}

export function useCloudProjectsBootstrap(): void {
    const authenticated = useUserStore((state) => state.authenticated);
    const userId = useUserStore((state) => state.user?.id);
    const projectsEnabled = useUserStore((state) => state.featureFlags.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    useEffect(() => {
        if (!CLOUD_BACKEND_CONFIGURED || !authenticated || !projectsEnabled || !userId || !hydrated) return;
        let disposed = false;
        const load = async () => {
            const projects = await listCloudProjects();
            if (disposed) return;
            const store = useCanvasStore.getState();
            for (const remote of projects) {
                const project = await fromProjection(remote);
                if (disposed) return;
                if (project) store.upsertCloudProject({ ...project, cloud: { ...project.cloud!, userId } });
            }
        };
        void load().catch(() => undefined);
        const reload = () => void load().catch(() => undefined);
        window.addEventListener("infinite-canvas:cloud-import-published", reload);
        return () => { disposed = true; window.removeEventListener("infinite-canvas:cloud-import-published", reload); };
    }, [authenticated, hydrated, projectsEnabled, userId]);
}

export function useCloudProjectSync(localProjectId: string) {
    const authenticated = useUserStore((state) => state.authenticated);
    const userId = useUserStore((state) => state.user?.id);
    const workspaceId = useUserStore((state) => state.workspaceId);
    const featureFlags = useUserStore((state) => state.featureFlags);
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === localProjectId));
    const queue = useRef<Promise<ProjectProjection | null>>(Promise.resolve(null));
    const lastDocument = useRef("");

    const persist = useCallback(async (): Promise<ProjectProjection | null> => {
        if (!CLOUD_BACKEND_CONFIGURED || !authenticated || !featureFlags.projects || !userId || !workspaceId) return null;
        const current = useCanvasStore.getState().projects.find((item) => item.id === localProjectId);
        if (!current || current.cloud?.conflictVersion) return null;
        const documentJson = projectDocument(current);
        const serialized = JSON.stringify({ title: current.title, documentJson });
        if (serialized === lastDocument.current && current.cloud) {
            return { id: current.cloud.projectId, workspaceId: current.cloud.workspaceId, title: current.title, documentJson, version: current.cloud.version, createdAt: current.createdAt, updatedAt: current.updatedAt } as ProjectProjection;
        }
        try {
            if (!current.cloud && hasLocalMediaReference(current)) return null;
            let remote = current.cloud
                ? await updateCloudProject(current.cloud.projectId, { title: current.title, documentJson, version: current.cloud.version })
                : await createCloudProject(
                      { title: current.title, documentJson, workspaceId: workspaceIdSchema.parse(workspaceId), clientProjectId: localProjectId },
                      `project-create:${userId}:${localProjectId}`,
                  );
            if (
                !current.cloud &&
                (remote.title !== current.title || JSON.stringify(remote.documentJson) !== JSON.stringify(documentJson))
            ) {
                remote = await updateCloudProject(remote.id, {
                    title: current.title,
                    documentJson,
                    version: remote.version,
                });
            }
            lastDocument.current = serialized;
            useCanvasStore.getState().setCloudBinding(localProjectId, { projectId: remote.id, version: remote.version, workspaceId: remote.workspaceId, userId });
            return remote;
        } catch (error) {
            if (error instanceof CloudApiError && error.detail.code === "project_version_conflict") {
                const currentVersion = Number(error.detail.details?.currentVersion || 0);
                const binding = useCanvasStore.getState().projects.find((item) => item.id === localProjectId)?.cloud;
                if (binding) useCanvasStore.getState().setCloudBinding(localProjectId, { ...binding, conflictVersion: currentVersion || binding.version });
            }
            throw error;
        }
    }, [authenticated, featureFlags.projects, localProjectId, userId, workspaceId]);

    const flush = useCallback(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        queue.current = queue.current.catch(() => null).then(persist);
        return queue.current;
    }, [persist]);

    useEffect(() => {
        if (!project || !authenticated || !featureFlags.projects || project.cloud?.conflictVersion) return;
        const timer = setTimeout(() => { void flush().catch(() => undefined); }, 1000);
        return () => clearTimeout(timer);
    }, [authenticated, featureFlags.projects, flush, project?.cloud?.conflictVersion, project?.title, project?.updatedAt]);

    const enabled = CLOUD_BACKEND_CONFIGURED && authenticated && featureFlags.projects;
    return {
        enabled,
        canResume: CLOUD_BACKEND_CONFIGURED && authenticated,
        canRunImage: enabled && featureFlags.imageGeneration && featureFlags.credits,
        canRunVideo: enabled && featureFlags.videoGeneration && featureFlags.credits,
        flush,
        conflictVersion: project?.cloud?.conflictVersion,
    };
}
