import { useCallback, useEffect, useRef, useState } from "react";

import { createCloudMigrationArchive } from "@/lib/canvas/cloud-migration-export";
import { createCloudImport, getCloudImport } from "@/services/api/cloud-imports";
import {
    loadCloudMigrationRecord,
    saveCloudMigrationRecord,
    type CloudMigrationRecord,
} from "@/services/cloud-migration";
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
    const enabled = useUserStore((state) => state.featureFlags.projects);
    const projectsHydrated = useCanvasStore((state) => state.hydrated);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const [record, setRecord] = useState<CloudMigrationRecord | null>(null);
    const [busy, setBusy] = useState(false);
    const activeRequest = useRef(false);

    const persist = useCallback(async (next: CloudMigrationRecord) => {
        await saveCloudMigrationRecord(next);
        setRecord(next);
        if (next.status === "published") window.dispatchEvent(new Event("infinite-canvas:cloud-import-published"));
        return next;
    }, []);

    const advance = useCallback(
        async (current: CloudMigrationRecord) => {
            if (activeRequest.current) return;
            activeRequest.current = true;
            setBusy(true);
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
                activeRequest.current = false;
                setBusy(false);
            }
        },
        [persist],
    );

    useEffect(() => {
        let disposed = false;
        void loadCloudMigrationRecord().then((value) => {
            if (!disposed) setRecord(value);
        });
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        if (!authenticated || !enabled || !record) return;
        if (record.status === "prepared") {
            void advance(record).catch(() => undefined);
            return;
        }
        if (!["uploaded", "validating", "importing"].includes(record.status)) return;
        const timer = window.setTimeout(() => void advance(record).catch(() => undefined), 2_000);
        return () => window.clearTimeout(timer);
    }, [advance, authenticated, enabled, record]);

    const start = useCallback(async () => {
        if (!authenticated || !enabled || !projectsHydrated || !assetsHydrated)
            throw new Error("Cloud migration is not available");
        setBusy(true);
        try {
            const clientExportId = crypto.randomUUID();
            const { archive, counts } = await createCloudMigrationArchive(
                useCanvasStore.getState().projects,
                useAssetStore.getState().assets,
                clientExportId,
            );
            const prepared = await persist({
                clientExportId,
                archive,
                counts,
                createdAt: new Date().toISOString(),
                status: "prepared",
            });
            await advance(prepared);
        } finally {
            setBusy(false);
        }
    }, [advance, assetsHydrated, authenticated, enabled, persist, projectsHydrated]);

    const retry = useCallback(async () => {
        if (!record) return;
        await advance(record);
    }, [advance, record]);

    return {
        record,
        busy,
        available: authenticated && enabled && projectsHydrated && assetsHydrated,
        start,
        retry,
    };
}
