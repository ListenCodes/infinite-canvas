import { localProjectsChangedSinceExport, type LocalProjectRevision } from "../../services/cloud-migration-policy.ts";

interface RemoteProjectIdentity {
    workspaceId: string;
    documentJson: { localProjectId: string };
}

interface LocalProjectIdentity {
    cloud?: { userId: string };
}

export async function stageAndApplyCloudProjects<Remote extends RemoteProjectIdentity, Local extends LocalProjectIdentity, Materialized>(options: {
    remotes: readonly Remote[];
    userId: string;
    workspaceId: string;
    mayReplaceUnbound: boolean;
    expectedLocalProjectIds?: readonly string[];
    approvedProjectRevisions?: Readonly<Record<string, string>>;
    currentProjectRevisions: () => readonly LocalProjectRevision[];
    findLocal: (localProjectId: string) => Local | undefined;
    materialize: (remote: Remote) => Promise<Materialized | null>;
    apply: (projects: readonly Materialized[]) => void;
}): Promise<void> {
    const staged: Materialized[] = [];
    const stagedLocalProjectIds = new Set<string>();
    const expectedLocalProjectIds = options.expectedLocalProjectIds ? new Set(options.expectedLocalProjectIds) : undefined;
    for (const remote of options.remotes) {
        if (remote.workspaceId !== options.workspaceId) continue;
        const localProjectId = remote.documentJson.localProjectId;
        if (expectedLocalProjectIds && !expectedLocalProjectIds.has(localProjectId)) continue;
        const existing = options.findLocal(localProjectId);
        if (existing?.cloud?.userId && existing.cloud.userId !== options.userId) continue;
        if (existing && !existing.cloud && (!options.mayReplaceUnbound || remote.workspaceId !== options.workspaceId)) continue;
        const project = await options.materialize(remote);
        if (project) {
            staged.push(project);
            stagedLocalProjectIds.add(localProjectId);
        }
    }
    const missing = (options.expectedLocalProjectIds ?? []).filter((id) => !stagedLocalProjectIds.has(id));
    if (missing.length) throw new Error(`Cloud migration activation is missing ${missing.length} imported projects`);
    if (
        options.approvedProjectRevisions &&
        localProjectsChangedSinceExport(options.approvedProjectRevisions, options.currentProjectRevisions())
    ) {
        throw new Error("Local projects changed while the cloud copy was being prepared");
    }
    options.apply(staged);
}
