import { create } from "zustand";
import type { CloudFeatureFlags } from "@infinite-canvas/contracts";

export type LocalUser = {
    id: string;
    username?: string;
    displayName: string;
    avatarUrl?: string;
    email?: string;
};

type UserStore = {
    user: LocalUser | null;
    authReady: boolean;
    authenticated: boolean;
    workspaceId: string | null;
    workspaceRole: "owner" | "editor" | "viewer" | null;
    platformRole: "user" | "admin" | null;
    wallet: { available: string; reserved: string } | null;
    featureFlags: CloudFeatureFlags;
    authDialogOpen: boolean;
    setAuthDialogOpen: (open: boolean) => void;
    setCloudSession: (value: {
        user: LocalUser;
        workspaceId: string;
        workspaceRole: "owner" | "editor" | "viewer";
        platformRole: "user" | "admin";
        wallet: { available: string; reserved: string };
        featureFlags: CloudFeatureFlags;
    }) => void;
    setAuthReady: (ready: boolean) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: null,
    authReady: false,
    authenticated: false,
    workspaceId: null,
    workspaceRole: null,
    platformRole: null,
    wallet: null,
    featureFlags: { projects: false, imageGeneration: false, videoGeneration: false, credits: false },
    authDialogOpen: false,
    setAuthDialogOpen: (authDialogOpen) => set({ authDialogOpen }),
    setCloudSession: ({ user, workspaceId, workspaceRole, platformRole, wallet, featureFlags }) =>
        set({ user, workspaceId, workspaceRole, platformRole, wallet, featureFlags, authenticated: true, authReady: true, authDialogOpen: false }),
    setAuthReady: (authReady) => set({ authReady }),
    // Cloud sign-out never removes canvas projects, assets, or any localForage data.
    clearSession: () => set({ user: null, authenticated: false, workspaceId: null, workspaceRole: null, platformRole: null, wallet: null, featureFlags: { projects: false, imageGeneration: false, videoGeneration: false, credits: false }, authReady: true }),
}));
