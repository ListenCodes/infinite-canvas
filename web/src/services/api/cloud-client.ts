import { apiErrorEnvelopeSchema, type ApiError } from "@infinite-canvas/contracts";
import type { ZodType } from "zod";

import { API_BASE_URL, CLOUD_BACKEND_CONFIGURED } from "@/constant/runtime-config";
import { useUserStore } from "@/stores/use-user-store";
import { assertCloudRequestIdentity, captureCloudRequestIdentity, type CloudRequestIdentity, type CloudSessionSnapshot } from "./cloud-request-identity";
import { getSupabaseClient } from "./supabase";

type CloudRequestInit = RequestInit & {
    expectedIdentity?: CloudRequestIdentity;
    expectedSessionUserId?: string;
};

export class CloudApiError extends Error {
    constructor(
        readonly status: number,
        readonly detail: ApiError,
    ) {
        super(detail.message);
        this.name = "CloudApiError";
    }
}

function sessionSnapshot(): CloudSessionSnapshot {
    const session = useUserStore.getState();
    return {
        authenticated: session.authenticated,
        userId: session.user?.id ?? null,
        workspaceId: session.workspaceId,
    };
}

async function accessToken(): Promise<{ token: string; userId: string }> {
    const client = getSupabaseClient();
    if (!CLOUD_BACKEND_CONFIGURED || !client) throw new Error("Cloud backend is not configured");
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token || !data.session.user?.id) throw new Error("Cloud session is not authenticated");
    return { token: data.session.access_token, userId: data.session.user.id };
}

export async function cloudFetch<T>(path: string, schema: ZodType<T>, init: CloudRequestInit = {}): Promise<T> {
    const { expectedIdentity: explicitIdentity, expectedSessionUserId, ...requestInit } = init;
    const expectedIdentity = explicitIdentity ?? captureCloudRequestIdentity(sessionSnapshot(), expectedSessionUserId);
    requestInit.signal?.throwIfAborted();
    const { token, userId } = await accessToken();
    requestInit.signal?.throwIfAborted();
    assertCloudRequestIdentity(expectedIdentity, userId, sessionSnapshot());
    const headers = new Headers(requestInit.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    if (requestInit.body && !(requestInit.body instanceof FormData)) headers.set("Content-Type", "application/json");
    requestInit.signal?.throwIfAborted();
    const response = await fetch(`${API_BASE_URL}${path}`, { ...requestInit, headers });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = apiErrorEnvelopeSchema.safeParse(body);
        throw new CloudApiError(
            response.status,
            parsed.success
                ? parsed.data.error
                : {
                      code: "invalid_server_response",
                      message: `Cloud request failed with HTTP ${response.status}`,
                      retryable: response.status >= 500,
                      correlationId: response.headers.get("x-request-id") || "unknown",
                  },
        );
    }
    return schema.parse(body);
}

export async function authorizedFetch(path: string, init: CloudRequestInit = {}): Promise<Response> {
    const { expectedIdentity: explicitIdentity, expectedSessionUserId, ...requestInit } = init;
    const expectedIdentity = explicitIdentity ?? captureCloudRequestIdentity(sessionSnapshot(), expectedSessionUserId);
    requestInit.signal?.throwIfAborted();
    const { token, userId } = await accessToken();
    requestInit.signal?.throwIfAborted();
    assertCloudRequestIdentity(expectedIdentity, userId, sessionSnapshot());
    const headers = new Headers(requestInit.headers);
    headers.set("Authorization", `Bearer ${token}`);
    requestInit.signal?.throwIfAborted();
    return fetch(`${API_BASE_URL}${path}`, { ...requestInit, headers });
}
