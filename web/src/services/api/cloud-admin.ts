import {
    adminAuditPageSchema,
    adminJobPageSchema,
    adminModelConfigInputSchema,
    adminModelConfigResponseSchema,
    adminUserPageSchema,
    adminUserFeaturesRequestSchema,
    adminUserFeaturesResponseSchema,
    adminUserStatusRequestSchema,
    adminUserStatusResponseSchema,
    adminWalletAdjustmentRequestSchema,
    adminWalletAdjustmentResponseSchema,
    providerChannelInputSchema,
    providerChannelMutationResponseSchema,
    providerChannelSchema,
    providerCredentialInputSchema,
    providerCredentialResponseSchema,
    unknownResolutionRequestSchema,
    unknownResolutionResponseSchema,
} from "@infinite-canvas/contracts";
import type { ZodType } from "zod";

import { cloudFetch } from "./cloud-client";

async function collectAdminPages<T>(path: string, schema: ZodType<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
        if (cursor) {
            if (seenCursors.has(cursor)) throw new Error("Admin pagination returned a repeated cursor");
            seenCursors.add(cursor);
        }
        const search: URLSearchParams = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
        const page: { items: T[]; nextCursor: string | null } = await cloudFetch(`${path}?${search.toString()}`, schema);
        items.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return items;
}

export const listAdminUsers = () => collectAdminPages("/v1/admin/users/page", adminUserPageSchema);
export const setAdminUserStatus = (userId: string, input: unknown) => cloudFetch(`/v1/admin/users/${userId}/status`, adminUserStatusResponseSchema, { method: "PATCH", body: JSON.stringify(adminUserStatusRequestSchema.parse(input)) });
export const setAdminUserFeatures = (userId: string, input: unknown) => cloudFetch(`/v1/admin/users/${userId}/features`, adminUserFeaturesResponseSchema, { method: "PATCH", body: JSON.stringify(adminUserFeaturesRequestSchema.parse(input)) });
export const adjustAdminWallet = (input: unknown, key: string) => cloudFetch("/v1/admin/wallet-adjustments", adminWalletAdjustmentResponseSchema, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(adminWalletAdjustmentRequestSchema.parse(input)) });
export const listAdminChannels = () => cloudFetch("/v1/admin/channels", providerChannelSchema.array());
export const saveAdminChannel = (input: unknown, key: string) => {
    const parsed = providerChannelInputSchema.parse(input);
    return cloudFetch(parsed.id ? `/v1/admin/channels/${parsed.id}` : "/v1/admin/channels", providerChannelMutationResponseSchema, { method: parsed.id ? "PUT" : "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(parsed) });
};
export const rotateAdminCredential = (channelId: string, input: unknown, key: string) => cloudFetch(`/v1/admin/channels/${channelId}/credentials`, providerCredentialResponseSchema, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(providerCredentialInputSchema.parse(input)) });
export const createAdminModel = (channelId: string, input: unknown, key: string) => cloudFetch(`/v1/admin/channels/${channelId}/models`, adminModelConfigResponseSchema, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(adminModelConfigInputSchema.parse(input)) });
export const listAdminJobs = () => collectAdminPages("/v1/admin/jobs/page", adminJobPageSchema);
export const resolveAdminUnknown = (attemptId: string, input: unknown, key: string) => cloudFetch(`/v1/admin/attempts/${attemptId}/resolve`, unknownResolutionResponseSchema, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(unknownResolutionRequestSchema.parse(input)) });
export const listAdminAudit = () => collectAdminPages("/v1/admin/audit/page", adminAuditPageSchema);
