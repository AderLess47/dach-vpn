import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

/**
 * Browser-Client für Auth-Sessions. Bewusst nur im Browser erzeugt: die Session
 * liegt in localStorage, auf dem Server hätte sie nichts zu suchen.
 */
export const supabaseBrowser: SupabaseClient | null =
  url && anonKey && typeof window !== "undefined"
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null;
