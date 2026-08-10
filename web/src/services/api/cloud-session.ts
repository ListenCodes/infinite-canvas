import { sessionBootstrapResponseSchema } from "@infinite-canvas/contracts";

import { cloudFetch } from "./cloud-client";

export function bootstrapCloudSession(expectedSessionUserId: string) {
    return cloudFetch("/v1/session/bootstrap", sessionBootstrapResponseSchema, { method: "POST", expectedSessionUserId });
}
