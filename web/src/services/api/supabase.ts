import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CLOUD_BACKEND_CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/constant/runtime-config";

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
    if (client !== undefined) return client;
    client = CLOUD_BACKEND_CONFIGURED
        ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
              auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
          })
        : null;
    return client;
}
