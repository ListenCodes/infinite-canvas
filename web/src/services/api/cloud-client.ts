import { apiErrorEnvelopeSchema, type ApiError } from "@infinite-canvas/contracts";
import type { ZodType } from "zod";

import { API_BASE_URL, CLOUD_BACKEND_CONFIGURED } from "@/constant/runtime-config";
import { getSupabaseClient } from "./supabase";

export class CloudApiError extends Error {
    constructor(readonly status: number, readonly detail: ApiError) {
        super(detail.message);
        this.name = "CloudApiError";
    }
}

async function accessToken(): Promise<string> {
    const client = getSupabaseClient();
    if (!CLOUD_BACKEND_CONFIGURED || !client) throw new Error("Cloud backend is not configured");
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) throw new Error("Cloud session is not authenticated");
    return data.session.access_token;
}

export async function cloudFetch<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const token = await accessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = apiErrorEnvelopeSchema.safeParse(body);
        throw new CloudApiError(response.status, parsed.success ? parsed.data.error : {
            code: "invalid_server_response",
            message: `Cloud request failed with HTTP ${response.status}`,
            retryable: response.status >= 500,
            correlationId: response.headers.get("x-request-id") || "unknown",
        });
    }
    return schema.parse(body);
}

export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await accessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}
