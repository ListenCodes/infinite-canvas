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
        const refresh = async () => {
            const currentRevision = ++revision;
            const { data } = await client.auth.getSession();
            if (disposed || currentRevision !== revision) return;
            if (!data.session?.user) {
                useUserStore.getState().clearSession();
                return;
            }
            try {
                const bootstrap = await bootstrapCloudSession();
                if (disposed || currentRevision !== revision) return;
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
                if (!disposed && currentRevision === revision) useUserStore.getState().setAuthReady(true);
            }
        };
        void refresh();
        const { data } = client.auth.onAuthStateChange(() => void refresh());
        return () => {
            disposed = true;
            data.subscription.unsubscribe();
        };
    }, []);
}
