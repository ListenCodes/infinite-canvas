import { useEffect } from "react";

import { CLOUD_BACKEND_CONFIGURED, CLOUD_BACKEND_ENABLED } from "@/constant/runtime-config";
import { bootstrapCloudSession } from "@/services/api/cloud-session";
import { getSupabaseClient } from "@/services/api/supabase";
import { useUserStore } from "@/stores/use-user-store";

export function useCloudSession(): void {
    useEffect(() => {
        const store = useUserStore.getState();
        if (!CLOUD_BACKEND_ENABLED || !CLOUD_BACKEND_CONFIGURED) {
            store.clearSession();
            return;
        }
        const client = getSupabaseClient();
        if (!client) {
            store.clearSession();
            return;
        }
        let disposed = false;
        let revision = 0;
        let retryTimer: number | undefined;
        let bootstrapFailures = 0;
        const refresh = async (resetFailures = false) => {
            if (resetFailures) bootstrapFailures = 0;
            const currentRevision = ++revision;
            const { data } = await client.auth.getSession();
            if (disposed || currentRevision !== revision) return;
            if (!data.session?.user) {
                useUserStore.getState().clearSession();
                return;
            }
            const sessionUserId = data.session.user.id;
            const currentStore = useUserStore.getState();
            if (currentStore.authenticated && currentStore.user?.id !== sessionUserId) currentStore.clearSession();
            try {
                const bootstrap = await bootstrapCloudSession(sessionUserId);
                if (disposed || currentRevision !== revision) return;
                bootstrapFailures = 0;
                useUserStore.getState().setCloudSession({
                    user: {
                        id: data.session.user.id,
                        email: data.session.user.email,
                        displayName: data.session.user.user_metadata.display_name || data.session.user.email?.split("@")[0] || "User",
                    },
                    workspaceId: bootstrap.workspaceId,
                    workspaceRole: bootstrap.role,
                    platformRole: bootstrap.platformRole,
                    wallet: bootstrap.wallet,
                    featureFlags: bootstrap.featureFlags,
                });
            } catch {
                if (disposed || currentRevision !== revision) return;
                useUserStore.getState().clearSession();
                bootstrapFailures += 1;
                if (bootstrapFailures <= 3) {
                    retryTimer = window.setTimeout(() => void refresh(), [500, 1_500, 5_000][bootstrapFailures - 1]);
                }
            }
        };
        void refresh();
        const { data } = client.auth.onAuthStateChange(() => {
            if (retryTimer !== undefined) window.clearTimeout(retryTimer);
            void refresh(true);
        });
        return () => {
            disposed = true;
            if (retryTimer !== undefined) window.clearTimeout(retryTimer);
            data.subscription.unsubscribe();
        };
    }, []);
}
