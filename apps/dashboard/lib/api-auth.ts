import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseBearerToken } from "@dachvpn/shared";

export type AuthOutcome =
  | { kind: "unconfigured" }
  | { kind: "unavailable" }
  | { kind: "unauthenticated"; code: "AUTH_REQUIRED" | "INVALID_TOKEN" }
  | { kind: "ok"; userId: string; email: string | null };

/**
 * Unterscheidet „Token ist ungültig“ von „Auth-Server nicht erreichbar“.
 *
 * Ohne diese Trennung würde jeder Netzwerk-Aussetzer als 401 durchschlagen —
 * und Clients würden eine gültige Sitzung verwerfen. Transportfehler und
 * 5xx-Antworten gelten deshalb als vorübergehend (503).
 */
export function isAuthUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; status?: number; message?: string };
  if (candidate.name === "AuthRetryableFetchError") return true;
  if (typeof candidate.status === "number" && (candidate.status === 0 || candidate.status >= 500)) {
    return true;
  }
  return /fetch failed|network|timeout|econnrefused|econnreset|enotfound|etimedout|und_err|socket hang up/i.test(
    candidate.message ?? "",
  );
}

/** Antwort, wenn die Token-Prüfung gerade nicht möglich ist (nicht: Token kaputt). */
export function authUnavailableResponse() {
  return NextResponse.json(
    {
      code: "AUTH_UNAVAILABLE",
      message: "Die Anmeldung kann gerade nicht geprüft werden. Bitte in wenigen Sekunden erneut versuchen.",
    },
    { status: 503, headers: { "retry-after": "2", "cache-control": "no-store" } },
  );
}

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
  if (error) {
    return isAuthUnavailable(error)
      ? { kind: "unavailable" }
      : { kind: "unauthenticated", code: "INVALID_TOKEN" };
  }
  if (!data.user) return { kind: "unauthenticated", code: "INVALID_TOKEN" };

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
