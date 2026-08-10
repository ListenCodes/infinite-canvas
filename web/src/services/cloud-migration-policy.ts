export interface CloudMigrationIdentity {
    userId: string;
    workspaceId: string;
}

interface CloudMigrationLockManager {
    request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
}

interface CloudMigrationStartRecord extends CloudMigrationIdentity {
    clientExportId?: string;
    importId?: string;
    status: string;
}

interface CloudProjectBindingIdentity extends CloudMigrationIdentity {
    projectId: string;
    version: number;
}

interface CloudProjectResponseIdentity {
    id: string;
    workspaceId: string;
    version: number;
}

export type CloudMigrationBusyCounts = Readonly<Record<string, number>>;

export interface LocalProjectRevision {
    id: string;
    updatedAt: string;
}

export interface CloudImportPublishedDetail extends CloudMigrationIdentity {
    clientExportId: string;
}

export function cloudMigrationRecordKey(identity: CloudMigrationIdentity): string {
    return `current-v2:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.workspaceId)}`;
}

export function withCloudMigrationLock<T>(identity: CloudMigrationIdentity, callback: () => Promise<T>, lockManager: CloudMigrationLockManager | undefined = globalThis.navigator?.locks): Promise<T> {
    if (!lockManager) throw new Error("This browser cannot safely coordinate cloud migration tabs");
    return lockManager.request(`infinite-canvas:${cloudMigrationRecordKey(identity)}`, { mode: "exclusive" }, callback);
}

export function updateCloudMigrationBusyCounts(counts: CloudMigrationBusyCounts, identity: CloudMigrationIdentity, delta: 1 | -1): CloudMigrationBusyCounts {
    const key = cloudMigrationRecordKey(identity);
    const nextCount = Math.max(0, (counts[key] ?? 0) + delta);
    if (nextCount === 0) {
        if (!(key in counts)) return counts;
        const next = { ...counts };
        delete next[key];
        return next;
    }
    return { ...counts, [key]: nextCount };
}

export function isCloudMigrationBusy(counts: CloudMigrationBusyCounts, identity: CloudMigrationIdentity | null): boolean {
    return identity ? (counts[cloudMigrationRecordKey(identity)] ?? 0) > 0 : false;
}

export function cloudMigrationBelongsTo(record: CloudMigrationIdentity, identity: CloudMigrationIdentity): boolean {
    return record.userId === identity.userId && record.workspaceId === identity.workspaceId;
}

export function cloudProjectBindingMatchesIdentity(binding: CloudMigrationIdentity | undefined, identity: CloudMigrationIdentity | null): boolean {
    if (!identity) return false;
    return !binding || cloudMigrationBelongsTo(binding, identity);
}

export function cloudProjectResponseMayUpdateBinding(options: {
    identity: CloudMigrationIdentity;
    capturedBinding: CloudProjectBindingIdentity | undefined;
    latestBinding: CloudProjectBindingIdentity | undefined;
    response: CloudProjectResponseIdentity;
}): boolean {
    const { capturedBinding, identity, latestBinding, response } = options;
    if (response.workspaceId !== identity.workspaceId || !cloudProjectBindingMatchesIdentity(latestBinding, identity)) return false;
    if (capturedBinding) {
        return Boolean(cloudMigrationBelongsTo(capturedBinding, identity) && latestBinding && latestBinding.projectId === capturedBinding.projectId && latestBinding.version === capturedBinding.version && response.id === capturedBinding.projectId);
    }
    return !latestBinding || (latestBinding.projectId === response.id && latestBinding.version <= response.version);
}

export function cloudProjectBindingUnchanged(captured: CloudProjectBindingIdentity | undefined, latest: CloudProjectBindingIdentity | undefined, identity: CloudMigrationIdentity): boolean {
    if (!captured) return !latest;
    return Boolean(latest && cloudMigrationBelongsTo(captured, identity) && cloudMigrationBelongsTo(latest, identity) && latest.projectId === captured.projectId && latest.version === captured.version);
}

export function cloudMigrationRecordMatchesExpected<T extends CloudMigrationStartRecord>(current: T | null, expected: T): current is T {
    return Boolean(current && cloudMigrationBelongsTo(current, expected) && current.clientExportId === expected.clientExportId && current.importId === expected.importId && current.status === expected.status);
}

export function isCloudMigrationIdentityLoaded(loadedIdentityKey: string | null, identity: CloudMigrationIdentity | null): boolean {
    return Boolean(identity && loadedIdentityKey === cloudMigrationRecordKey(identity));
}

const cloudMigrationLoadRetryDelaysMs = [500, 1_500] as const;

export function cloudMigrationLoadRetryDelay(failureCount: number): number | null {
    if (!Number.isInteger(failureCount) || failureCount < 1) return null;
    return cloudMigrationLoadRetryDelaysMs[failureCount - 1] ?? null;
}

export async function ensureCloudMigrationCanStart<T extends CloudMigrationStartRecord>(options: {
    identity: CloudMigrationIdentity;
    loadedIdentityKey: string | null;
    currentRecord: T | null;
    loadRecord: (identity: CloudMigrationIdentity) => Promise<T | null>;
}): Promise<T | null> {
    if (!isCloudMigrationIdentityLoaded(options.loadedIdentityKey, options.identity)) {
        throw new Error("Cloud migration record has not finished loading");
    }
    if (options.currentRecord && options.currentRecord.status !== "failed") {
        throw new Error("The current cloud migration must be resolved before starting another one");
    }
    const persisted = await options.loadRecord(options.identity);
    if (persisted && persisted.status !== "failed") {
        throw new Error("The current cloud migration must be resolved before starting another one");
    }
    return persisted;
}

export function localProjectsChangedSinceExport(baseline: Readonly<Record<string, string>>, current: readonly LocalProjectRevision[]): boolean {
    if (Object.keys(baseline).length !== current.length) return true;
    return current.some((project) => baseline[project.id] !== project.updatedAt);
}

export function isCloudImportPublishedFor(detail: unknown, identity: CloudMigrationIdentity): detail is CloudImportPublishedDetail {
    if (!detail || typeof detail !== "object") return false;
    const candidate = detail as Partial<CloudImportPublishedDetail>;
    return candidate.userId === identity.userId && candidate.workspaceId === identity.workspaceId && typeof candidate.clientExportId === "string" && candidate.clientExportId.length > 0;
}

export function cloudMigrationActivationMatches(record: CloudMigrationIdentity & { clientExportId: string }, detail: unknown): boolean {
    return isCloudImportPublishedFor(detail, record) && detail.clientExportId === record.clientExportId;
}
