// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Each analytics provider has its own variable; configured providers are enabled independently and all are disabled by default.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
    CLOUD_BACKEND_ENABLED?: string;
    API_BASE_URL?: string;
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);
export const API_BASE_URL = read("API_BASE_URL", import.meta.env.VITE_API_BASE_URL, "/api").replace(/\/$/, "");
export const SUPABASE_URL = read("SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL);
export const SUPABASE_ANON_KEY = read("SUPABASE_ANON_KEY", import.meta.env.VITE_SUPABASE_ANON_KEY);
export const CLOUD_BACKEND_ENABLED = /^(1|true|yes)$/i.test(read("CLOUD_BACKEND_ENABLED", import.meta.env.VITE_CLOUD_BACKEND_ENABLED, "false"));
export const CLOUD_BACKEND_CONFIGURED = CLOUD_BACKEND_ENABLED && Boolean(API_BASE_URL && SUPABASE_URL && SUPABASE_ANON_KEY);
