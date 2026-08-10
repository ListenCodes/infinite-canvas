export interface CloudMigrationIdentity {
    userId: string;
    workspaceId: string;
}

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

export function cloudMigrationBelongsTo(
    record: CloudMigrationIdentity,
    identity: CloudMigrationIdentity,
): boolean {
    return record.userId === identity.userId && record.workspaceId === identity.workspaceId;
}

export function localProjectsChangedSinceExport(
    baseline: Readonly<Record<string, string>>,
    current: readonly LocalProjectRevision[],
): boolean {
    if (Object.keys(baseline).length !== current.length) return true;
    return current.some((project) => baseline[project.id] !== project.updatedAt);
}

export function isCloudImportPublishedFor(
    detail: unknown,
    identity: CloudMigrationIdentity,
): detail is CloudImportPublishedDetail {
    if (!detail || typeof detail !== "object") return false;
    const candidate = detail as Partial<CloudImportPublishedDetail>;
    return (
        candidate.userId === identity.userId &&
        candidate.workspaceId === identity.workspaceId &&
        typeof candidate.clientExportId === "string" &&
        candidate.clientExportId.length > 0
    );
}

export function cloudMigrationActivationMatches(
    record: CloudMigrationIdentity & { clientExportId: string },
    detail: unknown,
): boolean {
    return isCloudImportPublishedFor(detail, record) && detail.clientExportId === record.clientExportId;
}
