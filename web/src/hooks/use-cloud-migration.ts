import { useCallback, useEffect, useRef, useState } from "react";

import { createCloudMigrationArchive } from "@/lib/canvas/cloud-migration-export";
import { createCloudImport, getCloudImport } from "@/services/api/cloud-imports";
import {
    loadCloudMigrationRecord,
    loadLegacyCloudMigrationRecord,
    saveCloudMigrationRecord,
    type CloudMigrationRecord,
    type LegacyCloudMigrationRecord,
} from "@/services/cloud-migration";
import {
    cloudMigrationBelongsTo,
    cloudMigrationRecordKey,
    isCloudMigrationBusy,
    localProjectsChangedSinceExport,
    updateCloudMigrationBusyCounts,
    type CloudMigrationBusyCounts,
    type CloudMigrationIdentity,
} from "@/services/cloud-migration-policy";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

function applyResponse(
    record: CloudMigrationRecord,
    response: Awaited<ReturnType<typeof createCloudImport>>,
): CloudMigrationRecord {
    return {
        ...record,
        importId: response.importId,
        status: response.status,
        counts: {
            projects: Number(response.counts.projects ?? record.counts.projects),
            assets: Number(response.counts.assets ?? record.counts.assets),
            objects: Number(response.counts.objects ?? record.counts.objects),
        },
        ...(response.error ? { error: response.error } : { error: undefined }),
        ...(response.publishedAt ? { publishedAt: response.publishedAt } : {}),
    };
}

export function useCloudMigration() {
    const authenticated = useUserStore((state) => state.authenticated);
    const userId = useUserStore((state) => state.user?.id);
    const workspaceId = useUserStore((state) => state.workspaceId);
    const enabled = useUserStore((state) => state.featureFlags.projects);
    const projectsHydrated = useCanvasStore((state) => state.hydrated);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const [record, setRecord] = useState<CloudMigrationRecord | null>(null);
    const [legacyRecord, setLegacyRecord] = useState<LegacyCloudMigrationRecord | null>(null);
    const [busyCounts, setBusyCounts] = useState<CloudMigrationBusyCounts>({});
    const activeRequests = useRef(new Set<string>());

    const changeBusy = useCallback((identity: CloudMigrationIdentity, delta: 1 | -1) => {
        setBusyCounts((counts) => updateCloudMigrationBusyCounts(counts, identity, delta));
    }, []);

    const persist = useCallback(async (next: CloudMigrationRecord) => {
        await saveCloudMigrationRecord(next);
        const session = useUserStore.getState();
        if (session.user?.id === next.userId && session.workspaceId === next.workspaceId) setRecord(next);
        return next;
    }, []);

    const advance = useCallback(
        async (current: CloudMigrationRecord) => {
            if (!userId || !workspaceId || !cloudMigrationBelongsTo(current, { userId, workspaceId })) {
                throw new Error("Cloud migration does not belong to the current account and workspace");
            }
            const requestKey = cloudMigrationRecordKey(current);
            if (activeRequests.current.has(requestKey)) return;
            activeRequests.current.add(requestKey);
            changeBusy(current, 1);
            try {
                const response =
                    current.status === "prepared" || current.status === "failed"
                        ? await createCloudImport(current.archive)
                        : current.importId
                          ? await getCloudImport(current.importId)
                          : await createCloudImport(current.archive);
                await persist(applyResponse(current, response));
            } catch (error) {
                await persist({
                    ...current,
                    status: "failed",
                    error: {
                        code: "client_request_failed",
                        message: error instanceof Error ? error.message : "Cloud migration request failed",
                    },
                });
                throw error;
            } finally {
                activeRequests.current.delete(requestKey);
                changeBusy(current, -1);
            }
        },
        [changeBusy, persist, userId, workspaceId],
    );

    useEffect(() => {
        let disposed = false;
        void loadLegacyCloudMigrationRecord().then((value) => {
            if (!disposed) setLegacyRecord(value);
        });
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        let disposed = false;
        setRecord(null);
        if (!authenticated || !userId || !workspaceId) return;
        void loadCloudMigrationRecord({ userId, workspaceId }).then((value) => {
            if (!disposed) setRecord(value);
        });
        return () => {
            disposed = true;
        };
    }, [authenticated, userId, workspaceId]);

    useEffect(() => {
        if (!authenticated || !enabled || !userId || !workspaceId || !record) return;
        if (!cloudMigrationBelongsTo(record, { userId, workspaceId })) return;
        if (record.status === "prepared") {
            void advance(record).catch(() => undefined);
            return;
        }
        if (!["uploaded", "validating", "importing"].includes(record.status)) return;
        const timer = window.setTimeout(() => void advance(record).catch(() => undefined), 2_000);
        return () => window.clearTimeout(timer);
    }, [advance, authenticated, enabled, record, userId, workspaceId]);

    const start = useCallback(async () => {
        if (!authenticated || !userId || !workspaceId || !enabled || !projectsHydrated || !assetsHydrated)
            throw new Error("Cloud migration is not available");
        if (record && record.status !== "failed") throw new Error("The current cloud migration must be resolved before starting another one");
        const identity = { userId, workspaceId };
        changeBusy(identity, 1);
        try {
            const clientExportId = crypto.randomUUID();
            const projects = useCanvasStore.getState().projects;
            const { archive, counts } = await createCloudMigrationArchive(
                projects,
                useAssetStore.getState().assets,
                clientExportId,
            );
            const prepared = await persist({
                userId,
                workspaceId,
                clientExportId,
                archive,
                counts,
                projectRevisions: Object.fromEntries(projects.map((project) => [project.id, project.updatedAt])),
                createdAt: new Date().toISOString(),
                status: "prepared",
            });
            await advance(prepared);
        } finally {
            changeBusy(identity, -1);
        }
    }, [advance, assetsHydrated, authenticated, changeBusy, enabled, persist, projectsHydrated, record, userId, workspaceId]);

    const retry = useCallback(async () => {
        if (!record || record.status !== "failed" || !userId || !workspaceId) return;
        if (!cloudMigrationBelongsTo(record, { userId, workspaceId })) return;
        await advance(record);
    }, [advance, record, userId, workspaceId]);

    const activate = useCallback(async () => {
        if (!record || record.status !== "published" || !userId || !workspaceId) return;
        if (!cloudMigrationBelongsTo(record, { userId, workspaceId })) return;
        const identity = { userId, workspaceId };
        changeBusy(identity, 1);
        try {
            const approvedProjectRevisions = Object.fromEntries(
                useCanvasStore.getState().projects.map((project) => [project.id, project.updatedAt]),
            );
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const finish = (error?: unknown) => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeout);
                    if (error) reject(error);
                    else resolve();
                };
                const timeout = window.setTimeout(() => finish(new Error("Cloud migration activation timed out")), 120_000);
                window.dispatchEvent(
                    new CustomEvent("infinite-canvas:cloud-import-published", {
                        detail: { userId, workspaceId, clientExportId: record.clientExportId, approvedProjectRevisions, complete: finish },
                    }),
                );
            });
            await persist({ ...record, activatedAt: record.activatedAt ?? new Date().toISOString() });
        } finally {
            changeBusy(identity, -1);
        }
    }, [changeBusy, persist, record, userId, workspaceId]);

    const localChangesSinceExport = record
        ? localProjectsChangedSinceExport(record.projectRevisions, useCanvasStore.getState().projects)
        : false;
    const currentIdentity = userId && workspaceId ? { userId, workspaceId } : null;

    return {
        record,
        legacyRecord,
        busy: isCloudMigrationBusy(busyCounts, currentIdentity),
        available: authenticated && Boolean(userId) && Boolean(workspaceId) && enabled && projectsHydrated && assetsHydrated,
        localChangesSinceExport,
        start,
        retry,
        activate,
    };
}
