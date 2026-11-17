import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseBearerToken } from "@dachvpn/shared";

export type AuthOutcome =
  | { kind: "unconfigured" }
  | { kind: "unauthenticated"; code: "AUTH_REQUIRED" | "INVALID_TOKEN" }
  | { kind: "ok"; userId: string; email: string | null };

export function supabaseServerEnv() {
  return {
    url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    anonKey: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
  };
}

/**
 * Verifiziert den Bearer-Token serverseitig gegen Supabase.
 *
 * Die Nutzer-ID kommt ausschließlich aus dieser Prüfung — niemals aus dem Body.
 */
export async function authenticate(request: Request): Promise<AuthOutcome> {
  const { url, anonKey } = supabaseServerEnv();
  if (!url || !anonKey) return { kind: "unconfigured" };

  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token) return { kind: "unauthenticated", code: "AUTH_REQUIRED" };

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return { kind: "unauthenticated", code: "INVALID_TOKEN" };

  return { kind: "ok", userId: data.user.id, email: data.user.email ?? null };
}

/** Service-Role-Client für Schreibpfade, die RLS bewusst umgehen müssen. */
export function serviceClient(): SupabaseClient | null {
  const { url, serviceKey } = supabaseServerEnv();
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
