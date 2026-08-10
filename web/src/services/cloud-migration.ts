import type { LocalDataImportResponse } from "@infinite-canvas/contracts";
import localforage from "localforage";

export interface CloudMigrationRecord {
    clientExportId: string;
    archive: Blob;
    createdAt: string;
    counts: { projects: number; assets: number; objects: number };
    importId?: string;
    status: "prepared" | LocalDataImportResponse["status"];
    error?: { code: string; message: string | null };
    publishedAt?: string;
}

const store = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "cloud_migration",
});
const CURRENT_RECORD_KEY = "current-v1";

export function loadCloudMigrationRecord() {
    return store.getItem<CloudMigrationRecord>(CURRENT_RECORD_KEY);
}

export async function saveCloudMigrationRecord(record: CloudMigrationRecord) {
    await store.setItem(CURRENT_RECORD_KEY, record);
    return record;
}
