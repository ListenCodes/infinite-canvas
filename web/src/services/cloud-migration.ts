import type { LocalDataImportResponse } from "@infinite-canvas/contracts";
import localforage from "localforage";

import { cloudMigrationRecordKey, type CloudMigrationIdentity } from "./cloud-migration-policy";

export interface CloudMigrationRecord {
    userId: string;
    workspaceId: string;
    clientExportId: string;
    archive: Blob;
    createdAt: string;
    counts: { projects: number; assets: number; objects: number };
    projectRevisions: Record<string, string>;
    importId?: string;
    status: "prepared" | LocalDataImportResponse["status"];
    error?: { code: string; message: string | null };
    publishedAt?: string;
    activatedAt?: string;
}

export type LegacyCloudMigrationRecord = Omit<CloudMigrationRecord, "userId" | "workspaceId" | "projectRevisions" | "activatedAt">;

const store = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "cloud_migration",
});
export function loadCloudMigrationRecord(identity: CloudMigrationIdentity) {
    return store.getItem<CloudMigrationRecord>(cloudMigrationRecordKey(identity));
}

export function loadLegacyCloudMigrationRecord() {
    return store.getItem<LegacyCloudMigrationRecord>("current-v1");
}

export async function saveCloudMigrationRecord(record: CloudMigrationRecord) {
    await store.setItem(cloudMigrationRecordKey(record), record);
    return record;
}
