export type CloudRequestIdentity = {
    userId: string;
    workspaceId: string | null;
};

export type CloudSessionSnapshot = {
    authenticated: boolean;
    userId: string | null;
    workspaceId: string | null;
};

export function captureCloudRequestIdentity(snapshot: CloudSessionSnapshot, expectedUserId?: string): CloudRequestIdentity {
    if (expectedUserId) return { userId: expectedUserId, workspaceId: null };
    if (!snapshot.authenticated || !snapshot.userId || !snapshot.workspaceId) {
        throw new DOMException("Cloud request identity is unavailable", "AbortError");
    }
    return { userId: snapshot.userId, workspaceId: snapshot.workspaceId };
}

export function assertCloudRequestIdentity(expected: CloudRequestIdentity, sessionUserId: string, current: CloudSessionSnapshot): void {
    if (sessionUserId !== expected.userId) {
        throw new DOMException("Cloud request identity changed", "AbortError");
    }
    if (expected.workspaceId === null) return;
    if (!current.authenticated || current.userId !== expected.userId || current.workspaceId !== expected.workspaceId) {
        throw new DOMException("Cloud request identity changed", "AbortError");
    }
}

export function isCloudRequestAbort(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}
